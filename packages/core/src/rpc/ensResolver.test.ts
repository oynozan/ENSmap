import pLimit from 'p-limit';
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  labelhash,
  UnknownRpcError,
  type PublicClient,
} from 'viem';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadEnv, resolveNamespace } from '../config/index.ts';
import { parseNameInput, type InterpretedName } from '../ens/index.ts';
import {
  CallCounter,
  createFixtureFetch,
  createHttpClient,
  FIXTURES_DIR,
  fixtureMode,
  ProviderError,
} from '../http/index.ts';
import type { Address } from '../names/index.ts';
import { createRpcClient } from './client.ts';
import { createEnsResolver } from './ensResolver.ts';

const MAINNET = resolveNamespace('mainnet', loadEnv({}));
const ADDRESS = /^0x[0-9a-f]{40}$/;
const WALLET: Address = `0x${'a1'.repeat(20)}`;
const RESOLVER: Address = `0x${'e1'.repeat(20)}`;

function name(raw: string): InterpretedName {
  const parsed = parseNameInput(raw);
  if (!parsed.ok) {
    throw new Error(`invalid test name ${raw}`);
  }
  return parsed.name;
}

/* Error rules against a stub client */

const UR_ERRORS = [
  'ResolverNotFound',
  'UnsupportedResolverProfile',
  'ResolverError',
].map((errorName) => ({
  type: 'error' as const,
  name: errorName,
  inputs: [{ name: 'data', type: 'bytes' as const }],
}));

function revert(errorName: string): BaseError {
  const data = encodeErrorResult({
    abi: UR_ERRORS,
    errorName,
    args: ['0x'],
  });
  const cause = new ContractFunctionRevertedError({
    abi: UR_ERRORS,
    data,
    functionName: 'resolveWithGateways',
  });
  return new BaseError('call failed', { cause });
}

interface StubMethods {
  getEnsResolver?: () => Promise<string>;
  getEnsAddress?: () => Promise<string | null>;
  getEnsName?: () => Promise<string | null>;
}

function stubClient(methods: StubMethods): PublicClient {
  return {
    getEnsResolver: () => Promise.resolve(RESOLVER),
    getEnsAddress: () => Promise.resolve(WALLET),
    getEnsName: () => Promise.resolve(null),
    ...methods,
  } as unknown as PublicClient;
}

describe('createEnsResolver error rules', () => {
  it.each(['ResolverNotFound', 'UnsupportedResolverProfile'])(
    'maps a %s revert to a null address without an error',
    async (errorName) => {
      const resolver = createEnsResolver(
        stubClient({ getEnsAddress: () => Promise.reject(revert(errorName)) }),
        { concurrency: 1 },
      );

      const result = await resolver.resolve([name('foo.eth')]);

      expect(result.get(name('foo.eth'))).toEqual({
        address: null,
        resolver: RESOLVER,
        error: null,
      });
    },
  );

  it('keeps the errorName of any other revert', async () => {
    const resolver = createEnsResolver(
      stubClient({
        getEnsAddress: () => Promise.reject(revert('ResolverError')),
      }),
      { concurrency: 1 },
    );

    const result = await resolver.resolve([name('foo.eth')]);

    expect(result.get(name('foo.eth'))).toEqual({
      address: null,
      resolver: RESOLVER,
      error: 'ResolverError',
    });
  });

  it("reports 'reverted' for a revert without a decodable errorName", async () => {
    const bare = new ContractFunctionRevertedError({
      abi: [],
      functionName: 'resolveWithGateways',
    });
    const resolver = createEnsResolver(
      stubClient({
        getEnsAddress: () =>
          Promise.reject(new BaseError('call failed', { cause: bare })),
      }),
      { concurrency: 1 },
    );

    const result = await resolver.resolve([name('foo.eth')]);

    expect(result.get(name('foo.eth'))?.error).toBe('reverted');
  });

  it('rethrows a wrapped ProviderError as-is', async () => {
    const providerError = new ProviderError('rpc: HTTP 500', {
      provider: 'rpc',
      status: 500,
      retryable: true,
    });
    const resolver = createEnsResolver(
      stubClient({
        getEnsAddress: () => Promise.reject(new UnknownRpcError(providerError)),
      }),
      { concurrency: 1 },
    );

    await expect(resolver.resolve([name('foo.eth')])).rejects.toBe(
      providerError,
    );
  });

  it('rethrows an error that is neither a revert nor a ProviderError', async () => {
    const other = new Error('boom');
    const resolver = createEnsResolver(
      stubClient({ getEnsAddress: () => Promise.reject(other) }),
      { concurrency: 1 },
    );

    await expect(resolver.resolve([name('foo.eth')])).rejects.toBe(other);
  });

  it('lowercases addresses and maps a zero resolver to null', async () => {
    const resolver = createEnsResolver(
      stubClient({
        getEnsResolver: () =>
          Promise.resolve('0x0000000000000000000000000000000000000000'),
        getEnsAddress: () =>
          Promise.resolve('0xABCDEF0000000000000000000000000000ABCDEF'),
      }),
      { concurrency: 1 },
    );

    const result = await resolver.resolve([name('foo.eth')]);

    expect(result.get(name('foo.eth'))).toEqual({
      address: '0xabcdef0000000000000000000000000000abcdef',
      resolver: null,
      error: null,
    });
  });

  it('maps a primary name that is not normalized to null', async () => {
    const resolver = createEnsResolver(
      stubClient({ getEnsName: () => Promise.resolve('Nick.eth') }),
      { concurrency: 1 },
    );

    expect(await resolver.primaryNames([WALLET])).toEqual(
      new Map([[WALLET, null]]),
    );
  });

  it('maps a reverted primary name lookup to null', async () => {
    const resolver = createEnsResolver(
      stubClient({
        getEnsName: () => Promise.reject(revert('ResolverError')),
      }),
      { concurrency: 1 },
    );

    expect(await resolver.primaryNames([WALLET])).toEqual(
      new Map([[WALLET, null]]),
    );
  });
});

/* Recorded fixtures */

const mode = fixtureMode(loadEnv());
const LIVE_TIMEOUT_MS = 120_000;
// Created before the global stub below, so it captures the real fetch
const recorded = createFixtureFetch({
  dir: FIXTURES_DIR,
  mode,
  secrets: MAINNET.secrets,
});
let fixtureMisses = 0;

const fixtureFetch: typeof fetch = async (input, init) => {
  try {
    return await recorded(input, init);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Fixture missing')) {
      fixtureMisses += 1;
    }
    throw error;
  }
};

function liveSetup(concurrency: number) {
  const counter = new CallCounter();
  const rpc = createHttpClient({
    provider: 'rpc',
    limits: MAINNET.rpc.limits,
    counter,
    secrets: MAINNET.secrets,
    fetch: fixtureFetch,
    ...(mode === 'replay' ? { sleep: () => Promise.resolve() } : {}),
  });
  const limit = pLimit(MAINNET.ccipLimits.concurrency);
  const ccip = { limited: 0 };
  const ccipLimit = <T>(fn: () => Promise<T>): Promise<T> => {
    ccip.limited += 1;
    return limit(fn);
  };
  const client = createRpcClient(MAINNET, { rpc, ccipLimit, counter });
  return {
    resolver: createEnsResolver(client, { concurrency }),
    counter,
    ccip,
  };
}

// Never registered, picked at random for this test
const UNREGISTERED = name('q7x0v3m9k2p5w8r1t4y6u0i3o5a7s9d2f4g6h8j1.eth');
const ONCHAIN_NAMES = [name('ens.eth'), name('nick.eth'), UNREGISTERED];

describe(
  'createEnsResolver against recorded fixtures',
  { timeout: mode === 'replay' ? 5_000 : LIVE_TIMEOUT_MS },
  () => {
    beforeAll(() => {
      fixtureMisses = 0;
      vi.stubGlobal('fetch', fixtureFetch);
    });

    afterAll(() => {
      vi.unstubAllGlobals();
    });

    it('resolves ens.eth to a lowercase address and resolver', async () => {
      const { resolver } = liveSetup(4);

      const result = await resolver.resolve([name('ens.eth')]);

      const ens = result.get(name('ens.eth'));
      expect(ens?.address).toMatch(ADDRESS);
      expect(ens?.resolver).toMatch(ADDRESS);
      expect(ens?.error).toBeNull();
    });

    it('answers an encoded-label name as unresolvable without a call', async () => {
      const { resolver, counter } = liveSetup(4);
      const encoded = name(`[${labelhash('ens').slice(2)}].eth`);

      const result = await resolver.resolve([encoded]);

      expect(result.get(encoded)).toEqual({
        address: null,
        resolver: null,
        error: 'unresolvable',
      });
      expect(counter.snapshot()).toEqual({});
    });

    it('resolves an unregistered .eth name to a null address without an error', async () => {
      const { resolver } = liveSetup(4);

      const result = await resolver.resolve([UNREGISTERED]);

      // The recorded Universal Resolver call reverts ResolverNotFound(bytes), selector 0x77209fe8
      expect(result.get(UNREGISTERED)).toMatchObject({
        address: null,
        error: null,
      });
    });

    it('reads the recorded primary names', async () => {
      const { resolver } = liveSetup(4);
      const ens = (await resolver.resolve([name('ens.eth')])).get(
        name('ens.eth'),
      );
      if (ens?.address == null || ens.resolver === null) {
        throw new Error('ens.eth did not resolve');
      }

      const primary = await resolver.primaryNames([ens.address, ens.resolver]);

      // Recorded values, the ens.eth wallet's primary name and none for its resolver contract
      expect(primary).toEqual(
        new Map([
          [ens.address, 'wallet.ensdao.eth'],
          [ens.resolver, null],
        ]),
      );
    });

    it('replays the same name set with concurrency 1 and 4 without a fixture miss', async () => {
      const serial = await liveSetup(1).resolver.resolve(ONCHAIN_NAMES);
      const parallel = await liveSetup(4).resolver.resolve(ONCHAIN_NAMES);

      expect(parallel).toEqual(serial);
      expect([...serial.keys()]).toEqual(ONCHAIN_NAMES);
      expect(fixtureMisses).toBe(0);
    });

    it('sends CCIP-Read gateway calls through ccipLimit and counts them', async () => {
      const { resolver, counter, ccip } = liveSetup(4);
      // ENS offchain resolver demo name, resolved through its CCIP-Read gateway
      const offchain = name('test.offchaindemo.eth');

      const result = await resolver.resolve([offchain]);

      expect(result.get(offchain)?.address).toMatch(ADDRESS);
      expect(counter.snapshot()['ccip-gateway']).toBe(1);
      expect(ccip.limited).toBe(1);
      expect(fixtureMisses).toBe(0);
    });
  },
);
