// Runs the situations described in the README automatically and prints what happened.
const { randomUUID } = require("node:crypto");
const { createApp } = require("./server.cjs");

async function startServer(options) {
  const app = createApp(options);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    stop: () => server.close(),
    async pay(amount, key) {
      const res = await fetch(`${base}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
        body: JSON.stringify({ amount }),
      });
      return { status: res.status, replayed: res.headers.get("x-cache-lookup"), body: await res.json() };
    },
    balance: async () => (await (await fetch(`${base}/balance`)).json()),
  };
}

const show = (label, r) =>
  console.log(`  ${label}: HTTP ${r.status}${r.replayed ? " (replayed from cache)" : ""} -> ${JSON.stringify(r.body)}`);

async function main() {
  console.log("\nSCENARIO 1: double click WITHOUT the shield (the problem)");
  let s = await startServer({ useShield: false });
  const [a, b] = await Promise.all([s.pay(100), s.pay(100)]);
  show("click 1", a);
  show("click 2", b);
  console.log("  final:", await s.balance(), "<- charged twice, balance should be 900");
  s.stop();

  s = await startServer();

  console.log("\nSCENARIO 2: double click WITH the shield (same Idempotency-Key)");
  const key = randomUUID();
  const [c, d] = await Promise.all([s.pay(100, key), s.pay(100, key)]);
  show("click 1", c);
  show("click 2", d);
  console.log("  final:", await s.balance(), "<- charged once");

  console.log("\nSCENARIO 3: network dropped, client retries after the first request finished");
  show("retry   ", await s.pay(100, key));
  console.log("  final:", await s.balance(), "<- still charged once, same response returned");

  console.log("\nSCENARIO 4: same key reused for a different amount (client bug)");
  show("amount 999", await s.pay(999, key));
  console.log("  final:", await s.balance(), "<- unchanged");

  console.log("\nSCENARIO 5: server error on the first try, then retry with the same key");
  const failKey = randomUUID();
  show("attempt 1", await s.pay(666, failKey));
  show("attempt 2", await s.pay(666, failKey));
  console.log("  final:", await s.balance(), "<- failed attempt did not block the retry");

  console.log("\nSCENARIO 6: a new key means a new payment");
  show("new key ", await s.pay(50, randomUUID()));
  console.log("  final:", await s.balance());

  s.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
