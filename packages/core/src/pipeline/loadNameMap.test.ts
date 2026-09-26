import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../config/env.ts';
import { resolveNamespace } from '../config/namespaces.ts';
import { parseNameInput, type InterpretedName } from '../ens/names.ts';
import { CallCounter } from '../http/counter.ts';
import { createFixtureFetch, FIXTURES_DIR } from '../http/fixtures.ts';
import { loadNameMap } from './loadNameMap.ts';

const ENV = loadEnv({ ENSMAP_FIXTURES: 'replay' });
const NOW = Date.parse('2026-09-26T00:00:00.000Z');

// viem sends CCIP-Read gateway calls through the global fetch
const ccipFetch = createFixtureFetch({
  dir: FIXTURES_DIR,
  mode: 'replay',
  secrets: [],
  inner: globalThis.fetch,
});

function name(raw: string): InterpretedName {
  const parsed = parseNameInput(raw);
  if (!parsed.ok) {
    throw new Error(`invalid test name ${raw}`);
  }
  return parsed.name;
}

function load(raw: string) {
  const counter = new CallCounter();
  return loadNameMap(resolveNamespace('sepolia-v2', ENV), name(raw), {
    env: ENV,
    counter,
    sleep: () => Promise.resolve(),
    now: () => NOW,
  });
}

describe('loadNameMap against recorded fixtures', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', ccipFetch);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('loads the gloomy.eth name map', async () => {
    const result = await load('gloomy.eth');

    expect(result.namespace).toBe('sepolia-v2');
    expect(result.root).toBe('gloomy.eth');
    expect(result.tree.nodes.size).toBe(5);
    expect(result.calls['ens-dev-graphql']).toBeGreaterThanOrEqual(1);
  });

  it('rejects a name with no recording', async () => {
    await expect(load('never-recorded-for-ensmap.eth')).rejects.toThrow(
      'Fixture missing',
    );
  });
});
