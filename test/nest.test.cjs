require("reflect-metadata");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  Controller,
  Post,
  Put,
  Get,
  Body,
  HttpCode,
  Module,
  UseInterceptors,
  BadRequestException,
} = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { Idempotent, IdempotencyInterceptor, IDEMPOTENCY_STORAGE } = require("../dist/nest-decorator");
const { IdempotencyStorage } = require("../dist");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Applies a decorator list to a controller method without needing TypeScript syntax.
function method(cls, name, decorators, params = []) {
  const target = cls.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  decorators.forEach((d) => d(target, name, descriptor));
  params.forEach((d, index) => d(target, name, index));
}

async function start(providers) {
  // Each app gets its own store so tests cannot see each other's keys.
  providers ??= [{ provide: IDEMPOTENCY_STORAGE, useValue: new IdempotencyStorage() }];
  const calls = { count: 0 };

  class PayController {
    create(body) {
      calls.count++;
      return { n: calls.count, echo: body };
    }
    async slow(body) {
      calls.count++;
      await sleep(80);
      return { n: calls.count };
    }
    fail() {
      calls.count++;
      if (calls.count === 1) throw new BadRequestException("nope");
      return { ok: true };
    }
    updated() {
      calls.count++;
      return { n: calls.count };
    }
    list() {
      calls.count++;
      return { n: calls.count };
    }
    nothing() {
      calls.count++;
    }
    custom(body) {
      calls.count++;
      return { n: calls.count };
    }
    manual(body) {
      calls.count++;
      return { n: calls.count };
    }
  }
  Controller("pay")(PayController);
  method(PayController, "create", [Post("create"), Idempotent()], [Body()]);
  method(PayController, "slow", [Post("slow"), Idempotent()], [Body()]);
  method(PayController, "fail", [Post("fail"), Idempotent()]);
  method(PayController, "updated", [Put("updated"), Idempotent()]);
  method(PayController, "list", [Get("list"), Idempotent()]);
  method(PayController, "nothing", [Post("nothing"), HttpCode(204), Idempotent()]);
  method(PayController, "custom", [Post("custom"), Idempotent({ ttlMs: 40 })], [Body()]);
  method(PayController, "manual", [Post("manual"), UseInterceptors(IdempotencyInterceptor), Idempotent()], [Body()]);

  class AppModule {}
  Module({ controllers: [PayController], providers })(AppModule);

  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  const url = await app.getUrl();
  const base = url.replace("[::1]", "127.0.0.1");
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
  return { request, calls, close: () => app.close() };
}

test("replays a POST with the original 201 status and the cache header", async (t) => {
  const s = await start();
  t.after(s.close);
  const first = await s.request("/pay/create", { key: "k", body: { a: 1 } });
  const second = await s.request("/pay/create", { key: "k", body: { a: 1 } });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(await second.json(), { n: 1, echo: { a: 1 } });
  assert.equal(second.headers.get("x-cache-lookup"), "HIT - Idempotent");
  assert.equal(s.calls.count, 1);
});

test("requests without a key run every time", async (t) => {
  const s = await start();
  t.after(s.close);
  await s.request("/pay/create", { body: {} });
  await s.request("/pay/create", { body: {} });
  assert.equal(s.calls.count, 2);
});

test("concurrent duplicates: one runs, the others get 409", async (t) => {
  const s = await start();
  t.after(s.close);
  const results = await Promise.all(
    Array.from({ length: 4 }, () => s.request("/pay/slow", { key: "race", body: {} })),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409]);
  assert.equal(s.calls.count, 1);
});

test("a different payload with the same key returns 422", async (t) => {
  const s = await start();
  t.after(s.close);
  await s.request("/pay/create", { key: "k", body: { amount: 1 } });
  const res = await s.request("/pay/create", { key: "k", body: { amount: 2 } });
  assert.equal(res.status, 422);
  assert.equal(s.calls.count, 1);
});

test("a thrown exception releases the key for a retry", async (t) => {
  const s = await start();
  t.after(s.close);
  assert.equal((await s.request("/pay/fail", { key: "k", body: {} })).status, 400);
  await sleep(10);
  assert.equal((await s.request("/pay/fail", { key: "k", body: {} })).status, 201);
  assert.equal(s.calls.count, 2);
});

test("PUT keeps its 200 status and is cached", async (t) => {
  const s = await start();
  t.after(s.close);
  await s.request("/pay/updated", { method: "PUT", key: "k", body: { a: 1 } });
  const again = await s.request("/pay/updated", { method: "PUT", key: "k", body: { a: 1 } });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("x-cache-lookup"), "HIT - Idempotent");
  assert.equal(s.calls.count, 1);
});

test("GET is not guarded", async (t) => {
  const s = await start();
  t.after(s.close);
  await s.request("/pay/list", { method: "GET", key: "k" });
  await s.request("/pay/list", { method: "GET", key: "k" });
  assert.equal(s.calls.count, 2);
});

test("handlers returning nothing are replayed", async (t) => {
  const s = await start();
  t.after(s.close);
  const first = await s.request("/pay/nothing", { key: "k", body: {} });
  const again = await s.request("/pay/nothing", { key: "k", body: {} });
  assert.equal(first.status, 204);
  assert.equal(again.status, 204);
  assert.equal(again.headers.get("x-cache-lookup"), "HIT - Idempotent");
  assert.equal(s.calls.count, 1);
});

test("the ttlMs option from the decorator is honoured", async (t) => {
  const s = await start();
  t.after(s.close);
  await s.request("/pay/custom", { key: "k", body: {} });
  await sleep(80);
  await s.request("/pay/custom", { key: "k", body: {} });
  assert.equal(s.calls.count, 2);
});

test("registering the interceptor twice does not trigger a false 409", async (t) => {
  const s = await start();
  t.after(s.close);
  const first = await s.request("/pay/manual", { key: "k", body: {} });
  assert.equal(first.status, 201);
  const again = await s.request("/pay/manual", { key: "k", body: {} });
  assert.equal(again.headers.get("x-cache-lookup"), "HIT - Idempotent");
  assert.equal(s.calls.count, 1);
});

test("a store provided through IDEMPOTENCY_STORAGE is used", async (t) => {
  const store = new IdempotencyStorage();
  const s = await start([{ provide: IDEMPOTENCY_STORAGE, useValue: store }]);
  t.after(s.close);
  await s.request("/pay/create", { key: "shared", body: {} });
  assert.equal(store.size, 1);
  assert.equal((await store.get("shared")).status, "COMPLETED");
});

test("an invalid key returns 400", async (t) => {
  const s = await start();
  t.after(s.close);
  const res = await s.request("/pay/create", { key: "x".repeat(300), body: {} });
  assert.equal(res.status, 400);
  assert.equal(s.calls.count, 0);
});
