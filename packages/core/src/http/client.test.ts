import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createHttpClient,
  ProviderError,
  type Classifier,
  type HttpRequest,
  type ProviderLimits,
} from './client.ts';
import { CallCounter } from './counter.ts';

type Reply =
  { status: number; body?: unknown; headers?: Record<string, string> } | Error;

const PROVIDER = 'test-provider';

const LIMITS: ProviderLimits = {
  concurrency: 4,
  minIntervalMs: 0,
  retries: 3,
  baseDelayMs: 100,
  maxDelayMs: 10_000,
  timeoutMs: 30_000,
};

const REQ: HttpRequest = { method: 'GET', url: 'https://api.example/items' };
const OK = z.object({ ok: z.boolean() });

// The last scripted reply repeats once the script runs out
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      init,
    });
    const reply = replies[Math.min(calls.length, replies.length) - 1];
    if (reply === undefined) {
      return Promise.reject(new Error('no reply scripted'));
    }
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status,
        headers: reply.headers,
      }),
    );
  };
  return { fetch, calls };
}

function setup(replies: Reply[], limits: Partial<ProviderLimits> = {}) {
  const { fetch, calls } = fakeFetch(replies);
  const sleeps: number[] = [];
  const counter = new CallCounter();
  const http = createHttpClient({
    provider: PROVIDER,
    limits: { ...LIMITS, ...limits },
    counter,
    secrets: [],
    fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => 1_000_000,
    random: () => 0.5,
  });
  return { http, calls, sleeps, counter };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

describe('createHttpClient retries and limits', () => {
  it('honours Retry-After on a 429, then resolves and counts both attempts', async () => {
    const { http, sleeps, counter } = setup([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: { ok: true } },
    ]);

    await expect(http.json(REQ, OK)).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([2000]);
    expect(counter.snapshot()[PROVIDER]).toBe(2);
  });

  it('gives up on a persistent 500 after retries + 1 attempts with full-jitter backoff', async () => {
    const { http, calls, sleeps } = setup([{ status: 500 }]);

    const error = await failure(http.json(REQ, OK));

    expect(error).toMatchObject({
      provider: PROVIDER,
      status: 500,
      retryable: true,
    });
    expect(calls).toHaveLength(LIMITS.retries + 1);
    // random() = 0.5 times min(maxDelayMs, baseDelayMs * 2 ** attempt)
    expect(sleeps).toEqual([50, 100, 200]);
  });

  it('caps exponential backoff at maxDelayMs', async () => {
    const { http, sleeps } = setup([{ status: 503 }], {
      retries: 5,
      baseDelayMs: 400,
      maxDelayMs: 1000,
    });

    await failure(http.json(REQ, OK));

    expect(sleeps).toEqual([200, 400, 500, 500, 500]);
  });

  it('treats a 400 as fatal after one attempt', async () => {
    const { http, calls, sleeps } = setup([{ status: 400 }]);

    const error = await failure(http.json(REQ, OK));

    expect(error).toMatchObject({ status: 400, retryable: false });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it.each([408, 425])('retries HTTP %i', async (status) => {
    const { http, calls } = setup([
      { status },
      { status: 200, body: { ok: true } },
    ]);

    await expect(http.json(REQ, OK)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('never has more than `concurrency` requests in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch: typeof globalThis.fetch = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return new Response('{"ok":true}', { status: 200 });
    };
    const http = createHttpClient({
      provider: PROVIDER,
      limits: { ...LIMITS, concurrency: 2 },
      counter: new CallCounter(),
      secrets: [],
      fetch,
    });

    await Promise.all(Array.from({ length: 10 }, () => http.json(REQ, OK)));

    expect(maxInFlight).toBe(2);
  });

  it('spaces request starts by minIntervalMs through the injected sleep', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const { fetch } = fakeFetch([{ status: 200, body: { ok: true } }]);
    const http = createHttpClient({
      provider: PROVIDER,
      limits: { ...LIMITS, minIntervalMs: 3000 },
      counter: new CallCounter(),
      secrets: [],
      fetch,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });

    await http.json(REQ, OK);
    await http.json(REQ, OK);
    await http.json(REQ, OK);

    expect(sleeps).toEqual([3000, 3000]);
  });

  it('treats a body that fails the schema as fatal and names the provider', async () => {
    const { http, calls } = setup([{ status: 200, body: { ok: 'yes' } }]);

    const error = await failure(http.json(REQ, OK));

    expect(error).toMatchObject({ provider: PROVIDER, retryable: false });
    expect(error.message).toContain(PROVIDER);
    expect(calls).toHaveLength(1);
  });

  it('treats a non-JSON 200 body as fatal', async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(new Response('<html>oops</html>', { status: 200 }));
    const http = createHttpClient({
      provider: PROVIDER,
      limits: LIMITS,
      counter: new CallCounter(),
      secrets: [],
      fetch,
    });

    const error = await failure(http.json(REQ, OK));

    expect(error).toMatchObject({ status: 200, retryable: false });
  });

  it('retries a timeout and passes an abort signal to fetch', async () => {
    const { http, calls } = setup([
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
      { status: 200, body: { ok: true } },
    ]);

    await expect(http.json(REQ, OK)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries a network error', async () => {
    const { http, calls } = setup([
      new TypeError('fetch failed'),
      { status: 200, body: { ok: true } },
    ]);

    await expect(http.json(REQ, OK)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('rethrows a non-network fetch failure unchanged and does not retry it', async () => {
    const missing = new Error(
      'Fixture missing for GET https://api.example/items',
    );
    const { http, calls } = setup([missing]);

    await expect(http.json(REQ, OK)).rejects.toBe(missing);
    expect(calls).toHaveLength(1);
  });

  it('retries a 200 body that classify marks retryable, before parsing the schema', async () => {
    const classify: Classifier = (status, body) =>
      typeof body === 'object' && body !== null && 'busy' in body
        ? new ProviderError('busy', {
            provider: '',
            status,
            retryable: true,
            retryAfterMs: null,
          })
        : null;
    const { http, calls } = setup([
      { status: 200, body: { busy: true } },
      { status: 200, body: { ok: true } },
    ]);

    await expect(http.json({ ...REQ, classify }, OK)).resolves.toEqual({
      ok: true,
    });
    expect(calls).toHaveLength(2);
  });

  it('stamps its own provider on a classified error', async () => {
    const classify: Classifier = (status) =>
      new ProviderError('nope', {
        provider: '',
        status,
        retryable: false,
        retryAfterMs: null,
      });
    const { http } = setup([{ status: 200, body: { ok: true } }]);

    const error = await failure(http.json({ ...REQ, classify }, OK));

    expect(error).toMatchObject({ provider: PROVIDER, retryable: false });
    expect(error.message).toContain('nope');
  });

  it('never lets classify downgrade a retryable status', async () => {
    const classify: Classifier = (status) =>
      new ProviderError('fatal by body', {
        provider: '',
        status,
        retryable: false,
        retryAfterMs: null,
      });
    const { http, calls, sleeps } = setup([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 502 },
    ]);

    const error = await failure(http.json({ ...REQ, classify }, OK));

    expect(error).toMatchObject({ status: 502, retryable: true });
    expect(error.message).toContain('fatal by body');
    expect(calls).toHaveLength(LIMITS.retries + 1);
    expect(sleeps).toEqual([2000, 100, 200]);
  });

  it('caps Retry-After at maxDelayMs', async () => {
    const { http, sleeps } = setup(
      [
        { status: 429, headers: { 'retry-after': '999' } },
        { status: 200, body: { ok: true } },
      ],
      { maxDelayMs: 1000 },
    );

    await http.json(REQ, OK);

    expect(sleeps).toEqual([1000]);
  });

  it('honours an HTTP-date Retry-After relative to now()', async () => {
    // now() is 1_000_000 ms, so a date 5 s later waits 5000 ms
    const { http, sleeps } = setup([
      {
        status: 503,
        headers: { 'retry-after': new Date(1_005_000).toUTCString() },
      },
      { status: 200, body: { ok: true } },
    ]);

    await http.json(REQ, OK);

    expect(sleeps).toEqual([5000]);
  });

  it('sends a JSON body with a JSON content type and the caller headers', async () => {
    const { http, calls } = setup([{ status: 200, body: { ok: true } }]);

    await http.json(
      {
        method: 'POST',
        url: 'https://api.example/rpc',
        headers: { 'x-extra': '1' },
        body: { a: 1 },
      },
      OK,
    );

    const init = calls[0]?.init;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"a":1}');
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-extra')).toBe('1');
  });
});
