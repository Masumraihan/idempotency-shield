const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { idempotencyShield, IdempotencyStorage } = require("../dist");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(configure, shieldOptions = {}) {
  const calls = { count: 0 };
  const app = express();
  app.use(express.json());
  app.use(idempotencyShield({ storage: new IdempotencyStorage(), ...shieldOptions }));
  configure(app, calls);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "POST", key, body, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    request,
    calls,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

test("requests without a key always run the handler", async (t) => {
  const s = await start((app, calls) =>
    app.post("/pay", (req, res) => res.status(201).json({ n: ++calls.count })),
  );
  t.after(s.close);
  await s.request("/pay", { body: { a: 1 } });
  await s.request("/pay", { body: { a: 1 } });
  assert.equal(s.calls.count, 2);
});

test("a retry replays the cached response without running the handler", async (t) => {
  const s = await start((app, calls) =>
    app.post("/pay", (req, res) => {
      res.set("X-Custom", "abc");
      res.status(201).json({ n: ++calls.count });
    }),
  );
  t.after(s.close);
  const first = await s.request("/pay", { key: "k1", body: { a: 1 } });
  const second = await s.request("/pay", { key: "k1", body: { a: 1 } });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(await second.json(), { n: 1 });
  assert.equal(first.headers.get("x-cache-lookup"), null);
  assert.equal(second.headers.get("x-cache-lookup"), "HIT - Idempotent");
  assert.equal(second.headers.get("x-custom"), "abc");
  assert.match(second.headers.get("content-type"), /application\/json/);
  assert.equal(s.calls.count, 1);
});

test("concurrent duplicates: one runs, the other gets 409", async (t) => {
  const s = await start((app, calls) =>
    app.post("/pay", async (req, res) => {
      calls.count++;
      await sleep(80);
      res.status(201).json({ ok: true });
    }),
  );
  t.after(s.close);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => s.request("/pay", { key: "race", body: { a: 1 } })),
  );
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409, 409]);
  assert.equal(s.calls.count, 1);
  const retry = await s.request("/pay", { key: "race", body: { a: 1 } });
  assert.equal(retry.status, 201);
  assert.equal(s.calls.count, 1);
});

test("reusing a key with a different payload returns 422", async (t) => {
  const s = await start((app, calls) =>
    app.post("/pay", (req, res) => res.status(201).json({ n: ++calls.count })),
  );
  t.after(s.close);
  await s.request("/pay", { key: "k", body: { amount: 10 } });
  const other = await s.request("/pay", { key: "k", body: { amount: 99 } });
  assert.equal(other.status, 422);
  assert.equal(s.calls.count, 1);
});

test("5xx responses release the key so the client can retry", async (t) => {
  const s = await start((app, calls) =>
    app.post("/flaky", (req, res) => {
      calls.count++;
      if (calls.count === 1) return res.status(500).json({ error: "boom" });
      res.status(201).json({ ok: true });
    }),
  );
  t.after(s.close);
  assert.equal((await s.request("/flaky", { key: "k", body: {} })).status, 500);
  await sleep(10);
  assert.equal((await s.request("/flaky", { key: "k", body: {} })).status, 201);
  assert.equal(s.calls.count, 2);
});

test("errors passed to next() release the key", async (t) => {
  const s = await start((app, calls) => {
    app.post("/throws", (req, res, next) => {
      calls.count++;
      if (calls.count === 1) return next(new Error("fail"));
      res.status(201).json({ ok: true });
    });
    app.use((err, req, res, next) => res.status(500).json({ message: err.message }));
  });
  t.after(s.close);
  assert.equal((await s.request("/throws", { key: "k", body: {} })).status, 500);
  await sleep(10);
  assert.equal((await s.request("/throws", { key: "k", body: {} })).status, 201);
});

// Express 4 does not forward rejected promises from handlers, Express 5 does.
const expressMajor = Number(require("express/package.json").version.split(".")[0]);

test("async handler rejections release the key", { skip: expressMajor < 5 }, async (t) => {
  const s = await start((app, calls) => {
    app.post("/rejects", async (req, res) => {
      calls.count++;
      if (calls.count === 1) throw new Error("async fail");
      res.status(201).json({ ok: true });
    });
    app.use((err, req, res, next) => res.status(500).json({ message: err.message }));
  });
  t.after(s.close);
  assert.equal((await s.request("/rejects", { key: "k", body: {} })).status, 500);
  await sleep(10);
  assert.equal((await s.request("/rejects", { key: "k", body: {} })).status, 201);
});

test("cacheErrors keeps 4xx responses for replay", async (t) => {
  const s = await start(
    (app, calls) =>
      app.post("/bad", (req, res) => {
        calls.count++;
        res.status(400).json({ error: "invalid" });
      }),
    { cacheErrors: true },
  );
  t.after(s.close);
  await s.request("/bad", { key: "k", body: {} });
  const again = await s.request("/bad", { key: "k", body: {} });
  assert.equal(again.status, 400);
  assert.equal(again.headers.get("x-cache-lookup"), "HIT - Idempotent");
  assert.equal(s.calls.count, 1);
});

test("4xx responses are discarded by default", async (t) => {
  const s = await start((app, calls) =>
    app.post("/bad", (req, res) => {
      calls.count++;
      res.status(400).json({ error: "invalid" });
    }),
  );
  t.after(s.close);
  await s.request("/bad", { key: "k", body: {} });
  await sleep(10);
  await s.request("/bad", { key: "k", body: {} });
  assert.equal(s.calls.count, 2);
});

test("GET requests bypass the shield", async (t) => {
  const s = await start((app, calls) =>
    app.get("/items", (req, res) => res.json({ n: ++calls.count })),
  );
  t.after(s.close);
  await s.request("/items", { method: "GET", key: "k" });
  await s.request("/items", { method: "GET", key: "k" });
  assert.equal(s.calls.count, 2);
});

test("PUT and PATCH are guarded", async (t) => {
  const s = await start((app, calls) => {
    app.put("/r", (req, res) => res.json({ n: ++calls.count }));
    app.patch("/r", (req, res) => res.json({ n: ++calls.count }));
  });
  t.after(s.close);
  await s.request("/r", { method: "PUT", key: "p", body: { a: 1 } });
  await s.request("/r", { method: "PUT", key: "p", body: { a: 1 } });
  await s.request("/r", { method: "PATCH", key: "q", body: { a: 1 } });
  await s.request("/r", { method: "PATCH", key: "q", body: { a: 1 } });
  assert.equal(s.calls.count, 2);
});

test("invalid keys are rejected with 400", async (t) => {
  const s = await start((app, calls) =>
    app.post("/pay", (req, res) => res.json({ n: ++calls.count })),
  );
  t.after(s.close);
  const tooLong = await s.request("/pay", { key: "x".repeat(300), body: {} });
  assert.equal(tooLong.status, 400);
  const blank = await s.request("/pay", { body: {}, headers: { "idempotency-key": "   " } });
  assert.equal(blank.status, 400);
  assert.equal(s.calls.count, 0);
});

test("scope keeps keys of different users apart", async (t) => {
  const s = await start(
    (app, calls) => app.post("/pay", (req, res) => res.status(201).json({ n: ++calls.count })),
    { scope: (req) => req.headers["x-user"] },
  );
  t.after(s.close);
  await s.request("/pay", { key: "same", body: {}, headers: { "x-user": "alice" } });
  const bob = await s.request("/pay", { key: "same", body: {}, headers: { "x-user": "bob" } });
  assert.equal(bob.headers.get("x-cache-lookup"), null);
  assert.equal(s.calls.count, 2);
});

test("plain text and binary bodies are replayed intact", async (t) => {
  const bytes = Buffer.from([0xff, 0x00, 0xfe, 0x80, 0x10]);
  const s = await start((app, calls) => {
    app.post("/text", (req, res) => {
      calls.count++;
      res.status(201).type("text/plain").send("héllo ✓");
    });
    app.post("/bin", (req, res) => {
      calls.count++;
      res.status(200).type("application/octet-stream").send(bytes);
    });
  });
  t.after(s.close);
  await s.request("/text", { key: "t", body: {} });
  const text = await s.request("/text", { key: "t", body: {} });
  assert.equal(await text.text(), "héllo ✓");
  assert.match(text.headers.get("content-type"), /text\/plain/);
  await s.request("/bin", { key: "b", body: {} });
  const bin = await s.request("/bin", { key: "b", body: {} });
  assert.deepEqual(Buffer.from(await bin.arrayBuffer()), bytes);
  assert.equal(s.calls.count, 2);
});

test("empty responses (204) are replayed", async (t) => {
  const s = await start((app, calls) =>
    app.post("/empty", (req, res) => {
      calls.count++;
      res.status(204).end();
    }),
  );
  t.after(s.close);
  await s.request("/empty", { key: "e", body: {} });
  const again = await s.request("/empty", { key: "e", body: {} });
  assert.equal(again.status, 204);
  assert.equal(again.headers.get("x-cache-lookup"), "HIT - Idempotent");
  assert.equal(s.calls.count, 1);
});

test("streamed responses (res.write) are cached", async (t) => {
  const s = await start((app, calls) =>
    app.post("/stream", (req, res) => {
      calls.count++;
      res.status(200).type("text/plain");
      res.write("part1-");
      res.end("part2");
    }),
  );
  t.after(s.close);
  await s.request("/stream", { key: "s", body: {} });
  const again = await s.request("/stream", { key: "s", body: {} });
  assert.equal(await again.text(), "part1-part2");
  assert.equal(s.calls.count, 1);
});

test("oversized responses are not cached and release the key", async (t) => {
  const s = await start(
    (app, calls) =>
      app.post("/big", (req, res) => {
        calls.count++;
        res.type("text/plain").send("x".repeat(100));
      }),
    { maxBodyBytes: 10 },
  );
  t.after(s.close);
  await s.request("/big", { key: "b", body: {} });
  await sleep(10);
  await s.request("/big", { key: "b", body: {} });
  assert.equal(s.calls.count, 2);
});

test("a failing store reports through onError and does not break the response", async (t) => {
  const errors = [];
  const broken = new IdempotencyStorage();
  broken.set = async () => {
    throw new Error("store down");
  };
  const s = await start(
    (app, calls) => app.post("/pay", (req, res) => res.status(201).json({ ok: true })),
    { storage: broken, onError: (e) => errors.push(e.message) },
  );
  t.after(s.close);
  const res = await s.request("/pay", { key: "k", body: {} });
  assert.equal(res.status, 201);
  await sleep(10);
  assert.deepEqual(errors, ["store down"]);
});

test("invalid options are rejected when the middleware is created", () => {
  assert.throws(() => idempotencyShield({ ttlMs: 0 }), TypeError);
  assert.throws(() => idempotencyShield({ ttlMs: Number.NaN }), TypeError);
  assert.throws(() => idempotencyShield({ lockTtlMs: -5 }), TypeError);
});

test("the lock expires after lockTtlMs when a request never finishes", async (t) => {
  const s = await start(
    (app, calls) =>
      app.post("/hang", (req, res) => {
        calls.count++;
        if (calls.count > 1) res.status(201).json({ ok: true });
        // The first request never responds, simulating a crash.
      }),
    { lockTtlMs: 50 },
  );
  t.after(s.close);
  const hanging = s.request("/hang", { key: "h", body: {} }).catch(() => undefined);
  await sleep(20);
  assert.equal((await s.request("/hang", { key: "h", body: {} })).status, 409);
  await sleep(60);
  assert.equal((await s.request("/hang", { key: "h", body: {} })).status, 201);
  void hanging;
});
