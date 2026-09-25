import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createHttpClient, ProviderError } from './client.ts';
import { CallCounter } from './counter.ts';
import { jsonRpcClassifier } from './jsonrpc.ts';

const HEADERS = new Headers();

function rpcError(code: number, data?: string) {
  return {
    jsonrpc: '2.0',
    id: 1,
    error: { code, message: 'boom', ...(data === undefined ? {} : { data }) },
  };
}

describe('jsonRpcClassifier', () => {
  it.each([-32005, 429, -32007])(
    'marks JSON-RPC error code %i retryable',
    (code) => {
      const error = jsonRpcClassifier(200, rpcError(code), HEADERS);

      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ retryable: true });
    },
  );

  it('passes other JSON-RPC errors through untouched', () => {
    expect(jsonRpcClassifier(200, rpcError(3, '0xdeadbeef'), HEADERS)).toBe(
      null,
    );
  });

  it('passes results through', () => {
    expect(
      jsonRpcClassifier(200, { jsonrpc: '2.0', id: 1, result: '0x1' }, HEADERS),
    ).toBe(null);
  });

  it('passes non-JSON bodies through', () => {
    expect(jsonRpcClassifier(502, 'Bad Gateway', HEADERS)).toBe(null);
  });
});

describe('jsonRpcClassifier through the HTTP client', () => {
  const RpcBody = z.object({
    result: z.string().optional(),
    error: z
      .object({ code: z.number(), data: z.string().optional() })
      .optional(),
  });

  function setup(bodies: unknown[]) {
    let calls = 0;
    const fetch: typeof globalThis.fetch = () => {
      calls += 1;
      const body = bodies[Math.min(calls, bodies.length) - 1];
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    };
    const http = createHttpClient({
      provider: 'rpc',
      limits: {
        concurrency: 1,
        minIntervalMs: 0,
        retries: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        timeoutMs: 1000,
      },
      counter: new CallCounter(),
      secrets: [],
      fetch,
      sleep: () => Promise.resolve(),
    });
    const post = () =>
      http.json(
        {
          method: 'POST',
          url: 'https://rpc.example/',
          body: { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' },
          classify: jsonRpcClassifier,
        },
        RpcBody,
      );
    return { post, calls: () => calls };
  }

  it('retries a rate-limit error code', async () => {
    const { post, calls } = setup([
      rpcError(-32005),
      { jsonrpc: '2.0', id: 1, result: '0x10' },
    ]);

    await expect(post()).resolves.toEqual({ result: '0x10' });
    expect(calls()).toBe(2);
  });

  it('returns a revert as the parsed body so the caller sees it', async () => {
    const { post, calls } = setup([rpcError(3, '0xdeadbeef')]);

    await expect(post()).resolves.toEqual({
      error: { code: 3, data: '0xdeadbeef' },
    });
    expect(calls()).toBe(1);
  });
});
