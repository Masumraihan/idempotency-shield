// Shows why a shared store matters. Two server processes sit behind a load balancer:
// first with separate in-memory stores (the problem), then with one shared Redis (the fix).
// Needs a running Redis: set REDIS_URL, or it uses redis://127.0.0.1:6379.
const express = require("express");
const Redis = require("ioredis");
const { randomUUID } = require("node:crypto");
const { idempotencyShield, IdempotencyStorage, RedisIdempotencyStore } = require("../dist");

async function startServer(name, storage, wallet) {
  const app = express();
  app.use(express.json());
  app.use(idempotencyShield({ storage }));
  app.post("/pay", async (req, res) => {
    await new Promise((r) => setTimeout(r, 300));
    wallet.balance -= req.body.amount;
    console.log(`  [${name}] charged ${req.body.amount}, balance is now ${wallet.balance}`);
    res.status(201).json({ server: name, balance: wallet.balance });
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/pay`;
  return {
    pay: async (key) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ amount: 100 }),
      });
      return `HTTP ${r.status}${r.headers.get("x-cache-lookup") ? " (replayed)" : ""} ${JSON.stringify(await r.json())}`;
    },
    stop: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

async function round(title, makeStore) {
  console.log(`\n${title}`);
  const wallet = { balance: 1000 };
  const a = await startServer("server-A", makeStore(), wallet);
  const b = await startServer("server-B", makeStore(), wallet);
  const key = randomUUID();
  // The client sends the request to A, loses the connection, and retries on B at once.
  const [r1, r2] = await Promise.all([a.pay(key), b.pay(key)]);
  console.log("  request on A:", r1);
  console.log("  retry on B  :", r2);
  console.log(`  final balance: ${wallet.balance} (should be 900)`);
  a.stop();
  b.stop();
}

async function main() {
  const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  try {
    await redis.connect();
  } catch {
    console.error("Cannot reach Redis. Start one (for example `redis-server`) or set REDIS_URL.");
    process.exit(1);
  }

  await round("ROUND 1: each server has its own memory store (problem)", () => new IdempotencyStorage());

  const prefix = `demo-${randomUUID()}:`;
  await round("ROUND 2: both servers share one Redis (fixed)", () => new RedisIdempotencyStore(redis, { keyPrefix: prefix }));

  redis.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
