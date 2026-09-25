import { setTimeout as delay } from 'node:timers/promises';

import pLimit from 'p-limit';
import type { z } from 'zod';

import type { CallCounter } from './counter.ts';
import { redact } from './redact.ts';

export interface ProviderLimits {
  concurrency: number;
  minIntervalMs: number;
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

export class ProviderError extends Error {
  override name = 'ProviderError';
  provider: string;
  status: number | null;
  retryable: boolean;
  retryAfterMs: number | null;

  constructor(
    message: string,
    fields: {
      provider: string;
      status: number | null;
      retryable: boolean;
      retryAfterMs?: number | null;
    },
  ) {
    super(message);
    this.provider = fields.provider;
    this.status = fields.status;
    this.retryable = fields.retryable;
    this.retryAfterMs = fields.retryAfterMs ?? null;
  }
}

// Classifiers may leave provider empty, the client fills it in
export type Classifier = (
  status: number,
  body: unknown,
  headers: Headers,
) => ProviderError | null;

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  classify?: Classifier;
}

export interface HttpClient {
  readonly provider: string;
  json<T>(req: HttpRequest, schema: z.ZodType<T>): Promise<T>;
}

const RETRYABLE_STATUSES = new Set([408, 425, 429]);
const SNIPPET_CHARS = 200;

export function parseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

// Network failures reject with TypeError, aborts with AbortError/TimeoutError
function isNetworkError(error: unknown): error is Error {
  return (
    error instanceof TypeError ||
    (error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError'))
  );
}

function describeError(error: Error): string {
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
  return `${error.name}: ${error.message}${cause}`;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
  return flat === '' ? '' : `: ${flat}`;
}

// Retry-After is either delta seconds or an HTTP date
function parseRetryAfter(headers: Headers, now: number): number | null {
  const value = headers.get('retry-after')?.trim();
  if (value === undefined || value === '') {
    return null;
  }
  if (/^\d+(\.\d+)?$/.test(value)) {
    return Math.round(Number(value) * 1000);
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function createHttpClient(opts: {
  provider: string;
  limits: ProviderLimits;
  counter: CallCounter;
  secrets: readonly string[];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}): HttpClient {
  const { provider, limits, counter, secrets } = opts;
  const fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? (() => Math.random());
  const limit = pLimit(limits.concurrency);
  let nextStartAt = Number.NEGATIVE_INFINITY;

  async function wait(ms: number): Promise<void> {
    if (ms > 0) {
      await sleep(ms);
    }
  }

  function fail(
    message: string,
    fields: {
      status: number | null;
      retryable: boolean;
      retryAfterMs: number | null;
    },
  ): ProviderError {
    return new ProviderError(redact(`${provider}: ${message}`, secrets), {
      provider,
      ...fields,
    });
  }

  // Reserve the slot before waiting so concurrent callers queue behind it
  async function throttle(): Promise<void> {
    const at = now();
    const startAt = Math.max(at, nextStartAt);
    nextStartAt = startAt + limits.minIntervalMs;
    await wait(startAt - at);
  }

  async function send(
    req: HttpRequest,
    target: string,
  ): Promise<{ response: Response; text: string }> {
    const headers = new Headers({ accept: 'application/json' });
    if (req.body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      headers.set(name, value);
    }
    try {
      const response = await fetchImpl(req.url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(limits.timeoutMs),
      });
      return { response, text: await response.text() };
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }
      throw fail(`network error for ${target}: ${describeError(error)}`, {
        status: null,
        retryable: true,
        retryAfterMs: null,
      });
    }
  }

  async function attempt<T>(
    req: HttpRequest,
    schema: z.ZodType<T>,
  ): Promise<T> {
    await throttle();
    counter.inc(provider);
    const target = `${req.method} ${req.url}`;
    const { response, text } = await send(req, target);
    const { status, headers } = response;
    const parsed = parseJson(text);
    const retryableStatus = RETRYABLE_STATUSES.has(status) || status >= 500;

    const classified =
      req.classify?.(status, parsed.ok ? parsed.value : text, headers) ?? null;
    if (classified !== null) {
      // classify may upgrade a status to retryable, never downgrade one
      const retryable = classified.retryable || retryableStatus;
      throw fail(`${classified.message} (${target})`, {
        status,
        retryable,
        retryAfterMs: retryable
          ? (classified.retryAfterMs ?? parseRetryAfter(headers, now()))
          : null,
      });
    }
    if (retryableStatus) {
      throw fail(`HTTP ${status} for ${target}${snippet(text)}`, {
        status,
        retryable: true,
        retryAfterMs: parseRetryAfter(headers, now()),
      });
    }
    if (!response.ok) {
      throw fail(`HTTP ${status} for ${target}${snippet(text)}`, {
        status,
        retryable: false,
        retryAfterMs: null,
      });
    }
    if (!parsed.ok) {
      throw fail(`non-JSON response for ${target}${snippet(text)}`, {
        status,
        retryable: false,
        retryAfterMs: null,
      });
    }
    const result = schema.safeParse(parsed.value);
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 3)
        .map(
          (issue) =>
            `${issue.path.map(String).join('.') || '(root)'} ${issue.message}`,
        )
        .join('; ');
      throw fail(`unexpected response shape for ${target}: ${issues}`, {
        status,
        retryable: false,
        retryAfterMs: null,
      });
    }
    return result.data;
  }

  function backoffMs(error: ProviderError, attemptIndex: number): number {
    if (error.retryAfterMs !== null) {
      return Math.min(limits.maxDelayMs, error.retryAfterMs);
    }
    // Full jitter over an exponential cap
    return (
      random() *
      Math.min(limits.maxDelayMs, limits.baseDelayMs * 2 ** attemptIndex)
    );
  }

  return {
    provider,
    json<T>(req: HttpRequest, schema: z.ZodType<T>): Promise<T> {
      return limit(async () => {
        for (let attemptIndex = 0; ; attemptIndex += 1) {
          try {
            return await attempt(req, schema);
          } catch (error) {
            if (
              !(error instanceof ProviderError) ||
              !error.retryable ||
              attemptIndex >= limits.retries
            ) {
              throw error;
            }
            await wait(backoffMs(error, attemptIndex));
          }
        }
      });
    },
  };
}
