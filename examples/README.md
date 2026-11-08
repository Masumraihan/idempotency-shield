# Try the idempotency shield

Run these from the package folder after `npm install`.

## 1. Automatic demo (easiest)

    npm run demo

It starts a fake payment server and runs six situations: double click without the shield, double click
with it, a retry after a network drop, a reused key with a different amount, a server error followed by a
retry, and a new key. Each step prints the HTTP status and the wallet balance.

## 2. Manual test with curl or Postman

Start the server (it listens on port 3000, or set `PORT`):

    npm run demo:server

In a second terminal:

    # First request: charges 100 (takes about half a second)
    curl -i -X POST localhost:3000/pay -H "content-type: application/json" \
      -H "Idempotency-Key: order-1001" -d '{"amount":100}'

    # Same key again: replayed, no second charge, header "X-Cache-Lookup: HIT - Idempotent"
    curl -i -X POST localhost:3000/pay -H "content-type: application/json" \
      -H "Idempotency-Key: order-1001" -d '{"amount":100}'

    # Same key, different amount: 422
    curl -i -X POST localhost:3000/pay -H "content-type: application/json" \
      -H "Idempotency-Key: order-1001" -d '{"amount":999}'

    # Double click: run these two at the same time; one gets 201, the other 409
    curl -s -X POST localhost:3000/pay -H "content-type: application/json" -H "Idempotency-Key: order-2000" -d '{"amount":50}' &
    curl -s -X POST localhost:3000/pay -H "content-type: application/json" -H "Idempotency-Key: order-2000" -d '{"amount":50}' &
    wait

    # Check the balance after everything
    curl localhost:3000/balance

Restarting the server resets the balance and the stored keys.

## 3. Two servers and Redis

This shows why a shared store matters when you run more than one server. It needs a running Redis
(`redis-server`, or Docker: `docker run -p 6379:6379 redis`). Use `REDIS_URL` for a non-default address.

    npm run demo:redis

Round 1 uses a separate memory store per server and charges twice. Round 2 shares one Redis and charges once.
