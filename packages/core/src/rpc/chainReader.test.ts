import pLimit from 'p-limit';
import { UnknownRpcError, type PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';

import { loadEnv, resolveNamespace } from '../config/index.ts';
import {
  CallCounter,
  createFixtureFetch,
  createHttpClient,
  FIXTURES_DIR,
  fixtureMode,
  ProviderError,
} from '../http/index.ts';
import { createChainReader } from './chainReader.ts';
import { createRpcClient } from './client.ts';

const MAINNET = resolveNamespace('mainnet', loadEnv({}));
const mode = fixtureMode(loadEnv());

describe('createChainReader', () => {
  it('rethrows a wrapped ProviderError as-is', async () => {
    const providerError = new ProviderError('rpc: HTTP 500', {
      provider: 'rpc',
      status: 500,
      retryable: true,
    });
    const client = {
      getBlock: () => Promise.reject(new UnknownRpcError(providerError)),
    } as unknown as PublicClient;

    await expect(
      createChainReader(client, { concurrency: 1 }).blockTimestamps([1n]),
    ).rejects.toBe(providerError);
  });

  it(
    'reads a recorded block timestamp once for a repeated block',
    { timeout: mode === 'replay' ? 5_000 : 60_000 },
    async () => {
      const counter = new CallCounter();
      const rpc = createHttpClient({
        provider: 'rpc',
        limits: MAINNET.rpc.limits,
        counter,
        secrets: MAINNET.secrets,
        fetch: createFixtureFetch({
          dir: FIXTURES_DIR,
          mode,
          secrets: MAINNET.secrets,
        }),
        ...(mode === 'replay' ? { sleep: () => Promise.resolve() } : {}),
      });
      const client = createRpcClient(MAINNET, {
        rpc,
        ccipLimit: pLimit(MAINNET.ccipLimits.concurrency),
        counter,
      });

      const times = await createChainReader(client, {
        concurrency: 4,
      }).blockTimestamps([17_000_000n, 17_000_000n]);

      // Timestamp 1680911891 in the recorded block
      expect(times).toEqual(
        new Map([[17_000_000n, new Date('2023-04-07T23:58:11.000Z')]]),
      );
      expect(counter.snapshot()).toEqual({ rpc: 1 });
    },
  );
});
