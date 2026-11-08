const test = require("node:test");
const assert = require("node:assert/strict");
const { IdempotencyStorage } = require("../dist");

test("setIfAbsent only stores the first record", async () => {
  const store = new IdempotencyStorage();
  assert.equal(await store.setIfAbsent("k", { status: "STARTED" }, 1000), true);
  assert.equal(await store.setIfAbsent("k", { status: "COMPLETED" }, 1000), false);
  assert.equal((await store.get("k")).status, "STARTED");
});

test("entries expire after the ttl", async () => {
  const store = new IdempotencyStorage();
  await store.set("k", { status: "COMPLETED" }, 20);
  assert.ok(await store.get("k"));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(await store.get("k"), null);
  assert.equal(await store.setIfAbsent("k", { status: "STARTED" }, 1000), true);
});

test("delete removes a key", async () => {
  const store = new IdempotencyStorage();
  await store.set("k", { status: "COMPLETED" }, 1000);
  await store.delete("k");
  assert.equal(await store.get("k"), null);
});

test("maxEntries evicts the oldest entries", async () => {
  const store = new IdempotencyStorage({ maxEntries: 2 });
  await store.set("a", { status: "COMPLETED" }, 1000);
  await store.set("b", { status: "COMPLETED" }, 1000);
  await store.set("c", { status: "COMPLETED" }, 1000);
  assert.equal(store.size, 2);
  assert.equal(await store.get("a"), null);
  assert.ok(await store.get("c"));
});

test("expired entries are swept on write", async () => {
  const store = new IdempotencyStorage({ sweepIntervalMs: 1 });
  await store.set("a", { status: "COMPLETED" }, 5);
  await new Promise((r) => setTimeout(r, 20));
  await store.set("b", { status: "COMPLETED" }, 1000);
  assert.equal(store.size, 1);
});
