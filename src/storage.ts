/**
 * A stored idempotency record. Records must stay JSON-serializable so that
 * external stores (Redis, SQL, ...) can persist them as-is.
 */
export interface IdempotentRecord {
  status: "STARTED" | "COMPLETED";
  /** Hash of the original request, used to detect key reuse with a different payload. */
  fingerprint?: string | undefined;
  statusCode?: number | undefined;
  /** Serialized response body (see `bodyEncoding`). */
  body?: string | undefined;
  /** "utf8" and "base64" hold raw bytes, "json" holds a JSON-serialized value. */
  bodyEncoding?: "utf8" | "base64" | "json" | undefined;
  headers?: Record<string, string | string[]> | undefined;
}

/**
 * Storage contract. Implement it to back the shield with Redis or a database.
 * `setIfAbsent` MUST be atomic (for example `SET key value NX PX ttl` in Redis),
 * because it is what prevents two concurrent requests from running the same operation.
 */
export interface IdempotencyStore {
  get(key: string): Promise<IdempotentRecord | null>;
  /** Stores the record only if the key does not exist. Resolves to true when it was stored. */
  setIfAbsent(key: string, record: IdempotentRecord, ttlMs: number): Promise<boolean>;
  set(key: string, record: IdempotentRecord, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface MemoryStoreOptions {
  /** Upper bound on stored keys. The oldest entries are evicted first. Default: 10000. */
  maxEntries?: number | undefined;
  /** Minimum time between sweeps of expired entries. Default: 60000. */
  sweepIntervalMs?: number | undefined;
}

interface Entry {
  record: IdempotentRecord;
  expiresAt: number;
}

/**
 * In-memory store. Suitable for a single process only: with several instances
 * or a cluster, use a shared store instead.
 */
export class IdempotencyStorage implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly sweepIntervalMs: number;
  private lastSweep = Date.now();

  constructor(options: MemoryStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  }

  /** Number of entries currently held, including expired ones not yet swept. */
  get size(): number {
    return this.entries.size;
  }

  async get(key: string): Promise<IdempotentRecord | null> {
    return this.live(key)?.record ?? null;
  }

  async setIfAbsent(key: string, record: IdempotentRecord, ttlMs: number): Promise<boolean> {
    // No await between the check and the write, so this is atomic within one process.
    if (this.live(key)) return false;
    this.write(key, record, ttlMs);
    return true;
  }

  async set(key: string, record: IdempotentRecord, ttlMs: number): Promise<void> {
    this.write(key, record, ttlMs);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private write(key: string, record: IdempotentRecord, ttlMs: number): void {
    this.sweepIfDue();
    // Delete first so the key moves to the end of the insertion order.
    this.entries.delete(key);
    this.entries.set(key, { record, expiresAt: Date.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  private sweepIfDue(): void {
    const now = Date.now();
    if (now - this.lastSweep < this.sweepIntervalMs) return;
    this.lastSweep = now;
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key);
    }
  }
}

let defaultStore: IdempotencyStorage | undefined;

/** Process-wide store used when no `storage` option is given. */
export function getDefaultStore(): IdempotencyStorage {
  defaultStore ??= new IdempotencyStorage();
  return defaultStore;
}
