import type { ApiError, Graph } from '@ensmap/core/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchGraph } from './api.ts';

const ROOT = '0xroot';

const GRAPH: Graph = {
  version: 1,
  nodes: [
    {
      id: ROOT,
      kind: 'name',
      label: 'gloomy.eth',
      tags: [],
      size: { metric: 'subnamesHeld', value: 0 },
    },
  ],
  edges: [],
  meta: {
    namespace: 'sepolia-v2',
    root: ROOT,
    computedAt: '2026-09-26T00:00:00.000Z',
    caps: { fetch: 1000 },
    filters: {},
    totals: { names: 1, indexed: { value: 1, exact: true }, wallets: 0 },
    truncated: [],
    warnings: [],
  },
};

function jsonFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function textFetch(status: number, body: string): typeof fetch {
  return () => Promise.resolve(new Response(body, { status }));
}

function apiError(error: ApiError['error']): ApiError {
  return { error };
}

// Settles only when its signal aborts, like a request to a stalled source
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    signal?.addEventListener(
      'abort',
      () => {
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

async function messageFor(fetchImpl: typeof fetch): Promise<string> {
  const result = await fetchGraph('gloomy.eth', { fetch: fetchImpl });
  if (result.ok) {
    throw new Error('expected an error result');
  }
  return result.message;
}

describe('fetchGraph', () => {
  it('requests the URL-encoded name on sepolia-v2', async () => {
    const fetchImpl = jsonFetch(200, GRAPH);
    await fetchGraph('❤.eth', { fetch: fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      '/api/map/name/%E2%9D%A4.eth?namespace=sepolia-v2',
    );
  });

  it('returns the parsed graph on a 200', async () => {
    await expect(
      fetchGraph('gloomy.eth', { fetch: jsonFetch(200, GRAPH) }),
    ).resolves.toEqual({ ok: true, graph: GRAPH });
  });

  it('maps 404 to the not-found line', async () => {
    const body = apiError({ code: 'not-found', message: 'Name not found' });
    expect(await messageFor(jsonFetch(404, body))).toBe(
      'Name not found on the Sepolia ENSv2 Beta',
    );
  });

  it('maps an invalid name to its first label reason', async () => {
    const body = apiError({
      code: 'invalid-name',
      message: 'Invalid name',
      labels: [
        { index: 0, label: 'a_b', reason: 'underscore allowed only at start' },
        { index: 1, label: 'c_d', reason: 'second reason' },
      ],
    });
    expect(await messageFor(jsonFetch(400, body))).toBe(
      'Invalid name: underscore allowed only at start (label "a_b")',
    );
  });

  it('maps a provider error to the data-source line', async () => {
    const body = apiError({
      code: 'provider-error',
      message: 'Provider rpc failed: down',
    });
    expect(await messageFor(jsonFetch(502, body))).toBe(
      'A data source is unavailable. Try again shortly.',
    );
  });

  it('treats a 502 without an API error body as an unreachable API', async () => {
    // The Vite dev proxy answers an empty text/plain 502 when the API is down
    expect(await messageFor(textFetch(502, ''))).toBe(
      "Can't reach the ENSmap API",
    );
  });

  it('maps a rejected fetch to the unreachable line', async () => {
    const failing: typeof fetch = () =>
      Promise.reject(new TypeError('Failed to fetch'));
    expect(await messageFor(failing)).toBe("Can't reach the ENSmap API");
  });

  it('rejects a 200 that is not a graph', async () => {
    expect(await messageFor(jsonFetch(200, { version: 2 }))).toBe(
      'Unexpected response from the ENSmap API',
    );
    expect(await messageFor(textFetch(200, '<!doctype html>'))).toBe(
      'Unexpected response from the ENSmap API',
    );
  });

  it('maps anything else to the generic line', async () => {
    const internal = apiError({ code: 'internal', message: 'Internal error' });
    const namespace = apiError({
      code: 'invalid-namespace',
      message: 'Unknown namespace; use mainnet or sepolia-v2',
    });
    const noLabels = apiError({
      code: 'invalid-name',
      message: 'Invalid name',
    });
    expect(await messageFor(jsonFetch(500, internal))).toBe(
      'Something went wrong',
    );
    expect(await messageFor(jsonFetch(400, namespace))).toBe(
      'Something went wrong',
    );
    expect(await messageFor(jsonFetch(400, noLabels))).toBe(
      'Something went wrong',
    );
  });

  it('times out', async () => {
    await expect(
      fetchGraph('gloomy.eth', { fetch: hangingFetch, timeoutMs: 20 }),
    ).resolves.toEqual({
      ok: false,
      message: 'The lookup took too long. Try again.',
    });
  });

  it('times out while the caller signal is still live', async () => {
    const controller = new AbortController();
    const result = await fetchGraph('gloomy.eth', {
      fetch: hangingFetch,
      signal: controller.signal,
      timeoutMs: 20,
    });
    controller.abort();
    expect(result).toEqual({
      ok: false,
      message: 'The lookup took too long. Try again.',
    });
  });

  it.each(['.', '..'])(
    'rejects %s as an empty label without a request',
    async (name) => {
      const fetchImpl = jsonFetch(200, GRAPH);
      await expect(fetchGraph(name, { fetch: fetchImpl })).resolves.toEqual({
        ok: false,
        message: 'Invalid name: empty label (label "")',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('rethrows an abort from the caller', async () => {
    const controller = new AbortController();
    const pending = fetchGraph('gloomy.eth', {
      fetch: hangingFetch,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rethrows when the caller signal is already aborted', async () => {
    await expect(
      fetchGraph('gloomy.eth', {
        fetch: hangingFetch,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rethrows a caller abort that lands while the body is read', async () => {
    const controller = new AbortController();
    const slowBody: typeof fetch = (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          init?.signal?.addEventListener('abort', () => {
            stream.error(init.signal?.reason);
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    const pending = fetchGraph('gloomy.eth', {
      fetch: slowBody,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('fetchGraph without AbortSignal.any', () => {
  const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any');

  afterEach(() => {
    if (any !== undefined) Object.defineProperty(AbortSignal, 'any', any);
  });

  function removeAny() {
    Object.defineProperty(AbortSignal, 'any', {
      value: undefined,
      configurable: true,
    });
  }

  it('still times out with a caller signal', async () => {
    removeAny();
    await expect(
      fetchGraph('gloomy.eth', {
        fetch: hangingFetch,
        signal: new AbortController().signal,
        timeoutMs: 20,
      }),
    ).resolves.toEqual({
      ok: false,
      message: 'The lookup took too long. Try again.',
    });
  });

  it('still rethrows an abort from the caller', async () => {
    removeAny();
    const controller = new AbortController();
    const pending = fetchGraph('gloomy.eth', {
      fetch: hangingFetch,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
