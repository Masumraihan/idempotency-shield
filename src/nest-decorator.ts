import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
  SetMetadata,
  UnprocessableEntityException,
  UseInterceptors,
  applyDecorators,
} from "@nestjs/common";
import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable, catchError, from, map, mergeMap, of, tap, throwError } from "rxjs";
import {
  CACHE_HIT_HEADER,
  CACHE_HIT_VALUE,
  GUARDED_METHODS,
  IDEMPOTENCY_KEY_HEADER,
  MESSAGES,
  beginRequest,
  buildStoreKey,
  createFingerprint,
  readIdempotencyKey,
  resolveOptions,
} from "./core";
import type { IdempotencyOptions, ResolvedOptions } from "./core";
import type { IdempotencyStore, IdempotentRecord } from "./storage";

export const IDEMPOTENT_KEY = "idempotent_options";

/** Injection token for providing a shared store (for example Redis) to the interceptor. */
export const IDEMPOTENCY_STORAGE = "IDEMPOTENCY_STORAGE";

/** Metadata key Nest uses for @HttpCode(). */
const HTTP_CODE_METADATA = "__httpCode__";

/** Marks requests already handled so that registering the interceptor twice is harmless. */
const HANDLED = Symbol("idempotency-shield.handled");

export type IdempotentOptions = IdempotencyOptions<any>;

/**
 * Enables idempotency for a controller method or a whole controller.
 * It also registers the interceptor, so no separate @UseInterceptors is needed.
 */
export const Idempotent = (options: IdempotentOptions = {}) =>
  applyDecorators(SetMetadata(IDEMPOTENT_KEY, options), UseInterceptors(IdempotencyInterceptor));

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Optional() @Inject(IDEMPOTENCY_STORAGE) private readonly storage?: IdempotencyStore,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== "http") return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    if (!GUARDED_METHODS.has(request.method) || request[HANDLED]) return next.handle();

    const parsed = readIdempotencyKey(request.headers?.[IDEMPOTENCY_KEY_HEADER]);
    if (!parsed.ok) throw new BadRequestException(parsed.message);
    if (parsed.key === undefined) return next.handle();
    const key = parsed.key;
    request[HANDLED] = true;

    const decorated = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(
      IDEMPOTENT_KEY,
      [context.getHandler(), context.getClass()],
    );
    const options = resolveOptions(decorated ?? {}, this.storage);

    const storeKey = buildStoreKey(options.scope?.(request), key);
    const fingerprint = createFingerprint(
      request.method,
      request.originalUrl ?? request.url,
      request.body,
    );
    const state = await beginRequest(options.storage, storeKey, fingerprint, options.lockTtlMs);

    switch (state.kind) {
      case "mismatch":
        throw new UnprocessableEntityException(MESSAGES.mismatch);
      case "in-progress":
        throw new ConflictException(MESSAGES.inProgress);
      case "replay":
        return of(this.replay(response, state.record));
      case "acquired":
        break;
    }

    // Nest applies the final status code after interceptors run, so work it out here.
    const statusCode =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ??
      (response.statusCode && response.statusCode !== 200
        ? response.statusCode
        : request.method === "POST"
          ? 201
          : 200);

    let emitted = false;
    return next.handle().pipe(
      mergeMap((data) => {
        emitted = true;
        return from(this.complete(options, storeKey, fingerprint, statusCode, data)).pipe(
          map(() => data),
        );
      }),
      tap({
        // A handler that completes without a value leaves nothing to replay.
        complete: () => {
          if (!emitted) void this.release(options, storeKey);
        },
      }),
      catchError((error) =>
        from(this.release(options, storeKey)).pipe(mergeMap(() => throwError(() => error))),
      ),
    );
  }

  private replay(response: any, record: IdempotentRecord): unknown {
    if (typeof record.statusCode === "number") response.status(record.statusCode);
    if (typeof response.setHeader === "function") {
      response.setHeader(CACHE_HIT_HEADER, CACHE_HIT_VALUE);
    } else if (typeof response.header === "function") {
      response.header(CACHE_HIT_HEADER, CACHE_HIT_VALUE);
    }
    return record.body === undefined ? undefined : JSON.parse(record.body);
  }

  private async complete(
    options: ResolvedOptions,
    storeKey: string,
    fingerprint: string,
    statusCode: number,
    data: unknown,
  ): Promise<void> {
    try {
      const serialized = serialize(data);
      if (!serialized.cacheable) {
        await options.storage.delete(storeKey);
        return;
      }
      await options.storage.set(
        storeKey,
        {
          status: "COMPLETED",
          fingerprint,
          statusCode,
          body: serialized.body,
          bodyEncoding: serialized.body === undefined ? undefined : "json",
        },
        options.ttlMs,
      );
    } catch (error) {
      // The response must still reach the client if the store fails.
      options.onError(error);
    }
  }

  private async release(options: ResolvedOptions, storeKey: string): Promise<void> {
    try {
      await options.storage.delete(storeKey);
    } catch (error) {
      options.onError(error);
    }
  }
}

/** Only plain JSON-serializable return values can be replayed; streams and buffers cannot. */
function serialize(data: unknown): { cacheable: boolean; body?: string | undefined } {
  if (data === undefined) return { cacheable: true };
  if (Buffer.isBuffer(data)) return { cacheable: false };
  if (typeof data === "object" && data !== null) {
    const candidate = data as { pipe?: unknown; getStream?: unknown };
    if (typeof candidate.pipe === "function" || typeof candidate.getStream === "function") {
      return { cacheable: false };
    }
  }
  try {
    const body = JSON.stringify(data);
    return body === undefined ? { cacheable: false } : { cacheable: true, body };
  } catch {
    return { cacheable: false };
  }
}
