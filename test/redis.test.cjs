const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const express = require("express");
const Redis = require("ioredis");
const { createClient } = require("redis");
const { idempotencyShield, RedisIdempotencyStore } = require("../dist");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Set REDIS_URL to run against an existing Redis (for example a Docker container).
// Otherwise the test starts its own throwaway redis-server, if one is installed.
const externalUrl = process.env.REDIS_URL;
const hasRedisServer = spawnSync("redis-server", ["--version"]).status === 0;
const skip =
  externalUrl || hasRedisServer
    ? false
    : "no Redis available: install redis-server or set REDIS_URL (see README)";

// Every key written by this file starts with this prefix, so a shared Redis is never touched otherwise.
const RUN = `idem-test-${randomUUID()}:`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitForRedis(url) {
  // The error listener keeps ioredis from printing "Unhandled error event" while we retry.
  const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  probe.on("error", () => {});
  for (let i = 0; i < 30; i++) {
    try {
      await probe.connect();
      await probe.ping();
      probe.disconnect();
      return true;
    } catch {
      await sleep(100);
    }
  }
  probe.disconnect();
  return false;
}

// Uses REDIS_URL when given, otherwise starts a throwaway redis-server for this file.
async function startRedis() {
  if (externalUrl) {
    if (!(await waitForRedis(externalUrl))) {
      throw new Error(`Cannot connect to REDIS_URL (${externalUrl}). Is Redis running and is the port published?`);
    }
    return { url: externalUrl, stop: () => {} };
  }

  const port = await freePort();
  const url = `redis://127.0.0.1:${port}`;
  const proc = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], {
    stdio: "ignore",
  });
  proc.on("error", () => {});
  if (!(await waitForRedis(url))) {
    proc.kill();
    throw new Error("redis-server could not be started. Set REDIS_URL to use an existing Redis instead.");
  }
  return { url, stop: () => proc.kill() };
}

// Removes only the keys this run created.
async function cleanup(client) {
  let cursor = "0";
  do {
    const [next, keys] = await client.scan(cursor, "MATCH", `${RUN}*`, "COUNT", 200);
    cursor = next;
    if (keys.length) await client.del(...keys);
  } while (cursor !== "0");
}

async function startServer(store, calls) {
  const app = express();
  app.use(express.json());
  app.use(idempotencyShield({ storage: store }));
  app.post("/pay", async (req, res) => {
    calls.count++;
    await sleep(80);
    res.status(201).json({ n: calls.count });
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/pay`;
  return {
    pay: (key, body = { a: 1 }) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      }),
    stop: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

test("RedisIdempotencyStore", { skip }, async (t) => {
  const redis = await startRedis();
  t.after(redis.stop);

  const ioredis = new Redis(redis.url);
  const nodeRedis = createClient({ url: redis.url });
  await nodeRedis.connect();
  t.after(async () => {
    await cleanup(ioredis);
    ioredis.disconnect();
    await nodeRedis.quit();
  });

  const clients = [
    ["ioredis", ioredis],
    ["node-redis", nodeRedis],
  ];

  for (const [name, client] of clients) {
    await t.test(`${name}: setIfAbsent, get and delete`, async () => {
      const store = new RedisIdempotencyStore(client, { keyPrefix: `${RUN}${name}-a:` });
      assert.equal(await store.get("k"), null);
      assert.equal(await store.setIfAbsent("k", { status: "STARTED", fingerprint: "f" }, 5000), true);
      assert.equal(await store.setIfAbsent("k", { status: "COMPLETED" }, 5000), false);
      assert.deepEqual(await store.get("k"), { status: "STARTED", fingerprint: "f" });
      await store.set("k", { status: "COMPLETED", statusCode: 201, body: "x", bodyEncoding: "utf8" }, 5000);
      assert.equal((await store.get("k")).status, "COMPLETED");
      await store.delete("k");
      assert.equal(await store.get("k"), null);
    });

    await t.test(`${name}: keys expire through the Redis ttl`, async () => {
      const store = new RedisIdempotencyStore(client, { keyPrefix: `${RUN}${name}-b:` });
      await store.set("k", { status: "COMPLETED" }, 60);
      assert.ok(await store.get("k"));
      await sleep(120);
      assert.equal(await store.get("k"), null);
      assert.equal(await store.setIfAbsent("k", { status: "STARTED" }, 5000), true);
    });

    await t.test(`${name}: 50 concurrent claims produce exactly one winner`, async () => {
      const store = new RedisIdempotencyStore(client, { keyPrefix: `${RUN}${name}-c:` });
      const results = await Promise.all(
        Array.from({ length: 50 }, () => store.setIfAbsent("k", { status: "STARTED" }, 5000)),
      );
      assert.equal(results.filter(Boolean).length, 1);
    });

    await t.test(`${name}: prefix is applied to the stored key`, async () => {
      const store = new RedisIdempotencyStore(client, { keyPrefix: `${RUN}${name}-d:` });
      await store.set("abc", { status: "COMPLETED" }, 5000);
      assert.ok(await client.get(`${RUN}${name}-d:abc`));
    });

    await t.test(`${name}: a corrupted entry is treated as missing`, async () => {
      const store = new RedisIdempotencyStore(client, { keyPrefix: `${RUN}${name}-e:` });
      await client.set(`${RUN}${name}-e:bad`, "{not json");
      assert.equal(await store.get("bad"), null);
    });
  }

  await t.test("two separate servers sharing Redis never run the same request twice", async () => {
    const calls = { count: 0 };
    // Each server has its own store object and its own middleware, like two real processes.
    const serverA = await startServer(new RedisIdempotencyStore(ioredis, { keyPrefix: `${RUN}two:` }), calls);
    const serverB = await startServer(new RedisIdempotencyStore(nodeRedis, { keyPrefix: `${RUN}two:` }), calls);
    t.after(() => {
      serverA.stop();
      serverB.stop();
    });

    // The same request lands on both servers at the same moment.
    const [a, b] = await Promise.all([serverA.pay("order-1"), serverB.pay("order-1")]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(calls.count, 1);

    // The retry goes to the other server and still gets the original answer.
    const retryA = await serverA.pay("order-1");
    const retryB = await serverB.pay("order-1");
    assert.equal(retryA.status, 201);
    assert.equal(retryB.status, 201);
    assert.equal(retryA.headers.get("x-cache-lookup"), "HIT - Idempotent");
    assert.equal(retryB.headers.get("x-cache-lookup"), "HIT - Idempotent");
    assert.equal(calls.count, 1);

    // A different payload for the same key is rejected on either server.
    assert.equal((await serverB.pay("order-1", { a: 2 })).status, 422);
  });

  await t.test("a stored response survives a new store object (server restart)", async () => {
    const calls = { count: 0 };
    const first = await startServer(new RedisIdempotencyStore(ioredis, { keyPrefix: `${RUN}restart:` }), calls);
    assert.equal((await first.pay("k")).status, 201);
    first.stop();

    const second = await startServer(new RedisIdempotencyStore(ioredis, { keyPrefix: `${RUN}restart:` }), calls);
    t.after(second.stop);
    const replay = await second.pay("k");
    assert.equal(replay.headers.get("x-cache-lookup"), "HIT - Idempotent");
    assert.equal(calls.count, 1);
  });
});
