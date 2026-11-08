# @http-state/idempotency-shield

Makes mutation requests (payments, orders, record creation) safe to retry. A request that carries an
`Idempotency-Key` header is processed exactly once, even if the client retries after a network failure or a
double click. The behavior follows the IETF `Idempotency-Key` HTTP header draft.

- Works with **Express** (4 and 5) and **NestJS** (tested with 11 and 12)
- Requires **Node.js 20 or newer** (tested on 20.0, 20.x, 22, 24 and 26)
- No runtime dependencies

## Install

```bash
npm install @http-state/idempotency-shield
```

## Express

```ts
import express from "express";
import { idempotencyShield } from "@http-state/idempotency-shield";

const app = express();
app.use(express.json()); // register body parsers first so the payload is part of the check
app.use(idempotencyShield({ ttlMs: 5 * 60 * 1000 }));
```

## NestJS

NestJS users import from the `/nest` entry point, so Express-only apps never load `@nestjs/*`.

```ts
import { Controller, Post, Body } from "@nestjs/common";
import { Idempotent } from "@http-state/idempotency-shield/nest";

@Controller("payments")
export class PaymentsController {
  @Post()
  @Idempotent({ ttlMs: 5 * 60 * 1000 }) // also registers the interceptor
  create(@Body() dto: CreatePaymentDto) {
    /* ... */
  }
}
```

To share one store (for example Redis) across the app, provide it under the `IDEMPOTENCY_STORAGE` token.

## How it works

Only `POST`, `PUT` and `PATCH` are guarded. Other methods pass straight through, and so do requests
without an `Idempotency-Key` header.

```
Idempotency-Key present?
├── no  → run the handler normally
└── yes → claim the key atomically
          ├── claimed          → status STARTED → run handler → save response → status COMPLETED
          ├── STARTED          → 409 Conflict (same request still in progress)
          ├── COMPLETED        → replay the saved response (header X-Cache-Lookup: HIT - Idempotent)
          └── different payload for this key → 422 Unprocessable Entity
```

1. **Claim (lock).** The first request atomically creates a `STARTED` record. A duplicate that arrives while
   the first is still running sees `STARTED` and receives `409`. Because the claim is a single atomic
   `setIfAbsent`, two simultaneous requests can never both run.
2. **Execute.** The handler runs normally. On Express the response is recorded at `res.write` / `res.end`, so
   `res.send`, `res.json`, streamed and binary responses are all covered. On NestJS the handler's return value is recorded.
3. **Memoize.** The status code and body (plus response headers on Express) are saved and the record becomes `COMPLETED` for `ttlMs`.
4. **Replay.** A retry with the same key skips your business logic and returns the saved response with the
   original status code.

### Failures

| Situation | What happens |
| --- | --- |
| Server crashes while processing | The key stays `STARTED` until `lockTtlMs` expires (default: `ttlMs`, at most 60 s). After that the client can retry. |
| Handler throws or returns an error | The key is released immediately so the client can fix the problem and retry. |
| 4xx / 5xx response (Express) | Discarded by default. Pass `cacheErrors: true` to replay 4xx/5xx responses as well. |
| Same key, different payload | `422`. The fingerprint covers method, URL and body. |
| Key is empty, longer than 255 characters or sent twice | `400`. |
| Response larger than `maxBodyBytes` (Express, default 1 MiB) | Not cached and the key is released. |
| Storage fails while saving the result | The response is still sent and the error is passed to `onError`. |

## Options

| Option | Default | Description |
| --- | --- | --- |
| `ttlMs` | `300000` | How long a completed response can be replayed. |
| `lockTtlMs` | `min(ttlMs, 60000)` | How long the in-progress lock is held. |
| `storage` | shared in-memory store | Any object implementing `IdempotencyStore`. |
| `scope` | none | `(req) => string`. Namespaces keys, usually by user id, so users can never read each other's cached responses. |
| `onError` | ignore | Called when the store fails after a response. |
| `cacheErrors` | `false` | Express only. Cache responses with status 400 and above. |
| `maxBodyBytes` | `1048576` | Express only. Largest response that will be cached. |

## Production storage (Redis)

The default store lives in the memory of one process. With several instances, or after a restart, a retry can
reach a server that has never seen the key and the operation runs twice. Give every instance the same Redis
store instead. The package ships `RedisIdempotencyStore`, which works with both `ioredis` and `redis`
(node-redis v4+). Neither library is a dependency of this package: you pass in your own client.

```ts
import Redis from "ioredis"; // or: import { createClient } from "redis";
import { idempotencyShield, RedisIdempotencyStore } from "@http-state/idempotency-shield";

const redis = new Redis(process.env.REDIS_URL);
app.use(idempotencyShield({ storage: new RedisIdempotencyStore(redis) }));
```

With node-redis, connect the client first (`await client.connect()`).
For NestJS, provide the same store under the `IDEMPOTENCY_STORAGE` token.

The lock is one atomic `SET key value PX ttl NX`, so simultaneous requests on different servers still produce
exactly one winner. Keys are prefixed with `idempotency:` (change it with `keyPrefix`) and expire through the
Redis TTL, so nothing needs cleaning up.

To use another database, implement `IdempotencyStore`. Its `setIfAbsent` must be atomic.

## Notes

- Register the Express middleware after body parsers.
- Replayed responses do not include `Set-Cookie`, `Date`, `Content-Length` or connection-level headers.
- The NestJS interceptor is tested on the Express platform. Fastify is not covered by the tests.
