import type { IdempotencyStore, IdempotentRecord } from "./storage";

/**
 * The few Redis commands the store needs. Both `ioredis` and `redis` (node-redis v4+)
 * clients satisfy this shape, so neither library is a dependency of this package.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  set(...args: any[]): Promise<unknown>;
}

export interface RedisStoreOptions {
  /** Prefix added to every key so the shield does not collide with other data. Default: "idempotency:". */
  keyPrefix?: string | undefined;
  /**
   * Which client library is used. It is detected automatically, because the two
   * libraries take their SET options in different forms.
   */
  client?: "ioredis" | "node-redis" | undefined;
}

/**
 * Redis-backed store. Share one instance across every server process so that a retry
 * is recognized no matter which instance receives it.
 *
 * The lock is a single `SET key value PX ttl NX`, which Redis executes atomically.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly prefix: string;
  private readonly kind: "ioredis" | "node-redis";

  constructor(
    private readonly redis: RedisLikeClient,
    options: RedisStoreOptions = {},
  ) {
    this.prefix = options.keyPrefix ?? "idempotency:";
    this.kind = options.client ?? detectClient(redis);
  }

  async get(key: string): Promise<IdempotentRecord | null> {
    const raw = await this.redis.get(this.prefix + key);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as IdempotentRecord;
    } catch {
      // A corrupted entry is treated as missing so it cannot block the key forever.
      return null;
    }
  }

  async setIfAbsent(key: string, record: IdempotentRecord, ttlMs: number): Promise<boolean> {
    const reply = await this.write(key, record, ttlMs, true);
    return reply === "OK";
  }

  async set(key: string, record: IdempotentRecord, ttlMs: number): Promise<void> {
    await this.write(key, record, ttlMs, false);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }

  private write(key: string, record: IdempotentRecord, ttlMs: number, onlyIfAbsent: boolean) {
    const name = this.prefix + key;
    const value = JSON.stringify(record);
    // PX takes whole milliseconds and must be at least 1.
    const px = Math.max(1, Math.ceil(ttlMs));

    if (this.kind === "node-redis") {
      return this.redis.set(name, value, onlyIfAbsent ? { PX: px, NX: true } : { PX: px });
    }
    return onlyIfAbsent
      ? this.redis.set(name, value, "PX", px, "NX")
      : this.redis.set(name, value, "PX", px);
  }
}

function detectClient(redis: RedisLikeClient): "ioredis" | "node-redis" {
  // node-redis clients expose a boolean `isOpen`, ioredis clients expose a string `status`.
  return typeof (redis as { isOpen?: unknown }).isOpen === "boolean" ? "node-redis" : "ioredis";
}
