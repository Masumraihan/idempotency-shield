// A fake payment server used to try out the idempotency shield.
// Run it alone with `npm run demo:server`, or let examples/scenario.cjs start it.
const express = require("express");
const { idempotencyShield } = require("../dist");

function createApp({ useShield = true } = {}) {
  const app = express();
  const wallet = { balance: 1000, charges: [] };
  let failedOnce = false;

  app.use(express.json());
  if (useShield) app.use(idempotencyShield({ ttlMs: 5 * 60 * 1000 }));

  app.get("/balance", (req, res) => res.json({ balance: wallet.balance, charges: wallet.charges.length }));

  app.post("/pay", async (req, res) => {
    const { amount } = req.body;
    await new Promise((r) => setTimeout(r, 500)); // simulates a slow payment gateway

    // Amount 666 fails on the first attempt only, to simulate a temporary server error.
    if (amount === 666 && !failedOnce) {
      failedOnce = true;
      return res.status(500).json({ message: "Gateway error, please retry" });
    }

    wallet.balance -= amount;
    wallet.charges.push(amount);
    console.log(`  [server] charged ${amount}, balance is now ${wallet.balance}`);
    res.status(201).json({ message: "Payment successful", charged: amount, balance: wallet.balance });
  });

  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Demo server with shield on http://localhost:${port}`));
}
