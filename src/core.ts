import { createHash } from "node:crypto";
import { getDefaultStore } from "./storage";
import type { IdempotencyStore, IdempotentRecord } from "./storage";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const CACHE_HIT_HEADER = "X-Cache-Lookup";
export const CACHE_HIT_VALUE = "HIT - Idempotent";

/** Only methods that are not idempotent by definition are guarded. */
export const GUARDED_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

export const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_TTL_MS = 60 * 1000;
const MAX_KEY_LENGTH = 255;

export const MESSAGES = {
  invalidKey: `The Idempotency-Key header must be a single non-empty value of at most ${MAX_KEY_LENGTH} characters.`,
  inProgress: "A request with this Idempotency-Key is already in progress.",
  mismatch: "This Idempotency-Key was already used with a different request.",
} as const;

export interface IdempotencyOptions<Req = any> {
  /** How long a completed response is kept for replay. Default: 5 minutes. */
  ttlMs?: number | undefined;
  /**
   * How long the in-progress lock is held. It is the window during which a crashed
   * request blocks retries. Default: the smaller of `ttlMs` and 60 seconds.
   */
  lockTtlMs?: number | undefined;
  /** Where records are kept. Default: a shared in-memory store. */
  storage?: IdempotencyStore | undefined;
  /**
   * Returns a namespace for the key, typically the authenticated user id, so that
   * different users can never read each other's cached responses.
   */
  scope?: ((req: Req) => string | undefined) | undefined;
  /** Called when the store fails while saving or releasing a record after a response. */
  onError?: ((error: unknown) => void) | undefined;
}

export interface ResolvedOptions<Req = any> {
  ttlMs: number;
  lockTtlMs: number;
  storage: IdempotencyStore;
  scope: ((req: Req) => string | undefined) | undefined;
  onError: (error: unknown) => void;
}

function assertDuration(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number of milliseconds.`);
  }
}

export function resolveOptions<Req>(
  options: IdempotencyOptions<Req>,
  fallbackStorage?: IdempotencyStore,
): ResolvedOptions<Req> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  assertDuration("ttlMs", ttlMs);
  const lockTtlMs = options.lockTtlMs ?? Math.min(ttlMs, DEFAULT_LOCK_TTL_MS);
  assertDuration("lockTtlMs", lockTtlMs);
  return {
    ttlMs,
    lockTtlMs,
    storage: options.storage ?? fallbackStorage ?? getDefaultStore(),
    scope: options.scope,
    onError: options.onError ?? (() => undefined),
  };
}

export type KeyResult = { ok: true; key: string | undefined } | { ok: false; message: string };

/** Validates the raw header value. A missing header is valid and means "not idempotent". */
export function readIdempotencyKey(value: string | string[] | undefined): KeyResult {
  if (value === undefined) return { ok: true, key: undefined };
  if (typeof value !== "string") return { ok: false, message: MESSAGES.invalidKey };
  const key = value.trim();
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    return { ok: false, message: MESSAGES.invalidKey };
  }
  return { ok: true, key };
}

/** Builds the storage key. The scope is URI-encoded so "a:b" + "c" never equals "a" + "b:c". */
export function buildStoreKey(scope: string | undefined, key: string): string {
  return scope ? `${encodeURIComponent(scope)}:${key}` : key;
}

/** Hashes the parts of a request that must be identical when a key is reused. */
export function createFingerprint(method: string, url: string, body: unknown): string {
  const hash = createHash("sha256");
  hash.update(`${method.toUpperCase()}\n${url}\n`);
  if (Buffer.isBuffer(body) || typeof body === "string") {
    hash.update(body);
  } else if (body !== undefined && body !== null) {
    try {
      hash.update(JSON.stringify(body) ?? "");
    } catch {
      // Unserializable bodies (for example circular objects) only count by method and URL.
    }
  }
  return hash.digest("hex");
}

export type BeginResult =
  | { kind: "acquired" }
  | { kind: "in-progress" }
  | { kind: "mismatch" }
  | { kind: "replay"; record: IdempotentRecord };

/**
 * Atomically claims the key, or reports what is already stored for it.
 * Reading and writing as two separate steps would let two simultaneous requests
 * both pass the check, so the claim always goes through `setIfAbsent`.
 */
export async function beginRequest(
  storage: IdempotencyStore,
  storeKey: string,
  fingerprint: string,
  lockTtlMs: number,
): Promise<BeginResult> {
  const lock: IdempotentRecord = { status: "STARTED", fingerprint };

  // A second attempt covers a record that expires between the claim and the read.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await storage.setIfAbsent(storeKey, lock, lockTtlMs)) return { kind: "acquired" };

    const existing = await storage.get(storeKey);
    if (!existing) continue;
    if (existing.fingerprint !== undefined && existing.fingerprint !== fingerprint) {
      return { kind: "mismatch" };
    }
    if (existing.status === "STARTED") return { kind: "in-progress" };
    return { kind: "replay", record: existing };
  }
  return { kind: "in-progress" };
}

/** Headers that describe the original connection or message framing and must not be replayed. */
const SKIPPED_HEADERS = new Set([
  "connection",
  "content-length",
  "date",
  "keep-alive",
  "set-cookie",
  "transfer-encoding",
  "x-cache-lookup",
]);

export function pickReplayHeaders(
  headers: Record<string, number | string | string[] | undefined>,
): Record<string, string | string[]> {
  const picked: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || SKIPPED_HEADERS.has(name.toLowerCase())) continue;
    picked[name] = Array.isArray(value) ? value : String(value);
  }
  return picked;
}
