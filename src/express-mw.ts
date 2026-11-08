import type { NextFunction, Request, Response } from "express";
import {
  CACHE_HIT_HEADER,
  CACHE_HIT_VALUE,
  GUARDED_METHODS,
  IDEMPOTENCY_KEY_HEADER,
  MESSAGES,
  beginRequest,
  buildStoreKey,
  createFingerprint,
  pickReplayHeaders,
  readIdempotencyKey,
  resolveOptions,
} from "./core";
import type { IdempotencyOptions, ResolvedOptions } from "./core";
import type { IdempotentRecord } from "./storage";

export interface ExpressIdempotencyOptions extends IdempotencyOptions<Request> {
  /**
   * Cache responses with a status of 400 or above too. By default they are discarded
   * so the client can fix the problem and retry with the same key. Default: false.
   */
  cacheErrors?: boolean | undefined;
  /** Responses larger than this are not cached and the key is released. Default: 1 MiB. */
  maxBodyBytes?: number | undefined;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Express middleware that makes POST, PUT and PATCH requests safe to retry.
 * Register it after body parsers so the request body is part of the fingerprint.
 */
export function idempotencyShield(options: ExpressIdempotencyOptions = {}) {
  const resolved = resolveOptions<Request>(options);
  const cacheErrors = options.cacheErrors ?? false;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async function idempotencyShieldMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      await handle(req, res, next, resolved, cacheErrors, maxBodyBytes);
    } catch (error) {
      // A failing store is treated as an error rather than skipping the protection.
      next(error);
    }
  };
}

async function handle(
  req: Request,
  res: Response,
  next: NextFunction,
  options: ResolvedOptions<Request>,
  cacheErrors: boolean,
  maxBodyBytes: number,
): Promise<void> {
  if (!GUARDED_METHODS.has(req.method)) return next();

  const parsed = readIdempotencyKey(req.headers[IDEMPOTENCY_KEY_HEADER]);
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }
  if (parsed.key === undefined) return next();

  const storeKey = buildStoreKey(options.scope?.(req), parsed.key);
  const fingerprint = createFingerprint(req.method, req.originalUrl || req.url, req.body);
  const state = await beginRequest(options.storage, storeKey, fingerprint, options.lockTtlMs);

  switch (state.kind) {
    case "mismatch":
      res.status(422).json({ message: MESSAGES.mismatch });
      return;
    case "in-progress":
      res.status(409).json({ message: MESSAGES.inProgress });
      return;
    case "replay":
      replay(res, state.record);
      return;
    case "acquired":
      captureResponse(res, options, storeKey, fingerprint, cacheErrors, maxBodyBytes);
      return next();
  }
}

function replay(res: Response, record: IdempotentRecord): void {
  res.status(record.statusCode ?? 200);
  for (const [name, value] of Object.entries(record.headers ?? {})) {
    res.setHeader(name, value);
  }
  res.setHeader(CACHE_HIT_HEADER, CACHE_HIT_VALUE);

  if (record.body === undefined) {
    res.end();
  } else {
    res.send(record.bodyEncoding === "base64" ? Buffer.from(record.body, "base64") : record.body);
  }
}

/**
 * Wraps res.write and res.end to record the response. Hooking the lowest level
 * covers res.send, res.json, res.sendFile and streamed responses alike.
 */
function captureResponse(
  res: Response,
  options: ResolvedOptions<Request>,
  storeKey: string,
  fingerprint: string,
  cacheErrors: boolean,
  maxBodyBytes: number,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  let finished = false;

  const collect = (chunk: unknown, encoding: unknown): void => {
    if (tooLarge || chunk === undefined || chunk === null || typeof chunk === "function") return;
    const buffer =
      typeof chunk === "string"
        ? Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8")
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maxBodyBytes) {
      tooLarge = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buffer);
  };

  const settle = (): void => {
    const statusCode = res.statusCode;
    const cacheable = !tooLarge && (statusCode < 400 || cacheErrors);

    // Fire and forget: the response must not wait on the store, and a store
    // failure must never break the response that is being sent.
    try {
      const task = cacheable
        ? options.storage.set(
            storeKey,
            buildRecord(statusCode, fingerprint, res.getHeaders(), Buffer.concat(chunks)),
            options.ttlMs,
          )
        : options.storage.delete(storeKey);
      Promise.resolve(task).catch(options.onError);
    } catch (error) {
      options.onError(error);
    }
  };

  const originalWrite = res.write;
  const originalEnd = res.end;

  res.write = function (this: Response, ...args: unknown[]): boolean {
    collect(args[0], args[1]);
    return (originalWrite as (...a: unknown[]) => boolean).apply(this, args);
  } as typeof res.write;

  res.end = function (this: Response, ...args: unknown[]): Response {
    collect(args[0], args[1]);
    if (!finished) {
      finished = true;
      settle();
    }
    return (originalEnd as (...a: unknown[]) => Response).apply(this, args);
  } as typeof res.end;
}

function buildRecord(
  statusCode: number,
  fingerprint: string,
  headers: Record<string, number | string | string[] | undefined>,
  body: Buffer,
): IdempotentRecord {
  const record: IdempotentRecord = {
    status: "COMPLETED",
    fingerprint,
    statusCode,
    headers: pickReplayHeaders(headers),
  };
  if (body.length > 0) {
    // Keep text readable in the store, and fall back to base64 for binary payloads.
    const text = body.toString("utf8");
    const isText = Buffer.from(text, "utf8").equals(body);
    record.body = isText ? text : body.toString("base64");
    record.bodyEncoding = isText ? "utf8" : "base64";
  }
  return record;
}
