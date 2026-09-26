import { loadEnv, resolveNamespace } from '@ensmap/core/config';
import { parseNameInput, type InterpretedName } from '@ensmap/core/ens';
import {
  createFixtureFetch,
  FIXTURES_DIR,
  fixtureMode,
} from '@ensmap/core/http';
import {
  NameMapJson,
  type Address,
  type DomainRecord,
  type NameMapResult,
  type TreeNode,
} from '@ensmap/core/names';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { formatTree } from '../format/tree.ts';
import { runCli, type CliDeps } from '../program.ts';

const recording = fixtureMode(loadEnv()) === 'record';
const ENV = loadEnv({ ENSMAP_FIXTURES: recording ? 'record' : 'replay' });
const NOW = Date.parse('2026-09-26T00:00:00.000Z');
const LIVE_TIMEOUT_MS = 600_000;
const realFetch = globalThis.fetch;

// Recording keeps the real clock and sleep, which the rate-limit throttle needs
const DEPS: Partial<CliDeps> = recording
  ? { env: ENV, fetch: realFetch }
  : {
      env: ENV,
      fetch: realFetch,
      sleep: () => Promise.resolve(),
      now: () => NOW,
    };

// viem sends CCIP-Read gateway calls through the global fetch
const ccipFetch = createFixtureFetch({
  dir: FIXTURES_DIR,
  mode: recording ? 'record' : 'replay',
  secrets: [],
  inner: realFetch,
});

async function run(argv: string[], deps: Partial<CliDeps> = DEPS) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(
    argv,
    {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    },
    deps,
  );
  return { code, stdout: out.join(''), stderr: err.join('') };
}

// Node lines come before the footer, which starts with the name count
function nodeLines(stdout: string): string[] {
  const lines = stdout.split('\n');
  const footer = lines.findIndex((line) => /^\d+ names \(indexed/.test(line));
  return lines.slice(0, footer);
}

function nodeName(line: string): string {
  return line.trim().split(' · ')[0] ?? '';
}

describe(
  'ensmap tree against recorded fixtures',
  { timeout: recording ? LIVE_TIMEOUT_MS : 5_000 },
  () => {
    beforeAll(() => {
      vi.stubGlobal('fetch', ccipFetch);
    });

    afterAll(() => {
      vi.unstubAllGlobals();
    });

    it('prints the ens.eth map as JSON', async () => {
      const { code, stdout, stderr } = await run([
        'tree',
        'ens.eth',
        '-n',
        'mainnet',
        '--json',
      ]);

      expect(code).toBe(0);
      const map = NameMapJson.parse(JSON.parse(stdout));
      expect(map.root).toBe('ens.eth');
      const nodes = Object.values(map.tree.nodes);
      // 22 children plus grandchildren under dnsname.ens.eth and wg.ens.eth, 38 in the recording
      expect(nodes.length).toBeGreaterThanOrEqual(23);
      expect(nodes).toHaveLength(38);
      expect(map.calls['ens-subgraph']).toBeGreaterThanOrEqual(1);
      expect(stderr).toMatch(/^API calls: .*ens-subgraph=\d+/m);
    });

    it('prints tiny.test.gloomy.eth once, with its other parent', async () => {
      const { code, stdout, stderr } = await run([
        'tree',
        'gloomy.eth',
        '-n',
        'sepolia-v2',
      ]);

      expect(code).toBe(0);
      const tiny = nodeLines(stdout).filter(
        (line) => nodeName(line) === 'tiny.test.gloomy.eth',
      );
      expect(tiny).toHaveLength(1);
      expect(tiny[0]).toContain('also under: ');
      expect(stderr).toContain('API calls: ');
    });

    it('shows the registry seller-a.eth shares with vet402.eth and the canonical paths', async () => {
      const { code, stdout } = await run([
        'tree',
        'seller-a.eth',
        '-n',
        'sepolia-v2',
      ]);

      expect(code).toBe(0);
      expect(stdout).toContain('registry shared with: vet402.eth');
      expect(stdout).not.toContain('index-mismatch');
      const children = nodeLines(stdout).filter((line) => /^ {2}\S/.test(line));
      const aliased = children.filter((line) => line.includes('alias-path'));
      for (const line of aliased) {
        const label = nodeName(line).split('.')[0] ?? '';
        expect(line).toContain(`canonical: ${label}.vet402.eth`);
        // Each alias path falls back to seller-a.eth's resolver in the recording
        expect(line).toContain(' · no wallet · ');
        expect(line).toContain('tags: alias-path, alias-unresolved');
      }
      // agent-1 is canonical under seller-a.eth itself in the recording
      expect(aliased.map(nodeName)).toEqual([
        'agent-2.seller-a.eth',
        'atst.seller-a.eth',
        'obs.seller-a.eth',
      ]);
      expect(children.map(nodeName)).toContain('agent-1.seller-a.eth');
    });

    it('exits 2 for a name the source does not know', async () => {
      const { code, stderr } = await run([
        'tree',
        'q7x0v3m9k2p5w8r1t4y6u0i3o5a7s9d2f4g6h8j1.eth',
        '-n',
        'sepolia-v2',
      ]);

      expect(code).toBe(2);
      expect(stderr).toContain(
        'Name not found in sepolia-v2 via ens-dev-graphql (alias paths of shared registries are not indexed by name)',
      );
    });
  },
);

describe('ensmap tree argument and provider errors', () => {
  it('exits 1 with the per-label error for an invalid name', async () => {
    const { code, stderr } = await run(['tree', 'a_b.eth']);

    expect(code).toBe(1);
    expect(stderr).toContain('underscore allowed only at start');
    expect(stderr).toContain('API calls: none');
  });

  it('exits 1 for an unknown namespace', async () => {
    const { code, stderr } = await run(['tree', 'ens.eth', '-n', 'goerli']);

    expect(code).toBe(1);
    expect(stderr).toContain('mainnet, sepolia-v2');
  });

  it('exits 1 for a --max-names that is not a positive integer', async () => {
    const { code, stderr } = await run(['tree', 'ens.eth', '--max-names', '0']);

    expect(code).toBe(1);
    expect(stderr).toContain('--max-names');
  });

  it('exits 1 for a --max-names above the fetch cap', async () => {
    const { code, stderr } = await run([
      'tree',
      'ens.eth',
      '--max-names',
      '1001',
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain('1000');
  });

  it('exits 3 and suggests GRAPH_API_KEY when the subgraph stays rate-limited', async () => {
    let calls = 0;
    const rateLimited: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(
        Response.json({
          message: 'Rate-limit on ensdomains/ens community key exceeded',
        }),
      );
    };

    // Fixtures off, so the synthetic fetch answers instead of a recording
    const { code, stderr } = await run(['tree', 'ens.eth'], {
      env: loadEnv({ ENSMAP_FIXTURES: 'off' }),
      fetch: rateLimited,
      sleep: () => Promise.resolve(),
      now: () => NOW,
    });

    const { retries } = resolveNamespace('mainnet', loadEnv({})).nameSource
      .limits;
    expect(code).toBe(3);
    expect(calls).toBe(retries + 1);
    expect(stderr).toContain('ens-subgraph');
    expect(stderr).toContain('GRAPH_API_KEY');
    expect(stderr).toContain(`API calls: ens-subgraph=${retries + 1}`);
  });

  it('exits 0 with registration dates and a warning when record history fails', async () => {
    const replay = createFixtureFetch({
      dir: FIXTURES_DIR,
      mode: 'replay',
      secrets: [],
    });
    let historyCalls = 0;
    const historyDown: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if ((await request.clone().text()).includes('query NodeHistory')) {
        historyCalls += 1;
        return new Response('upstream down', { status: 500 });
      }
      return replay(request);
    };

    // Fixtures off, so history fails while every other call replays
    const { code, stdout } = await run(
      ['tree', 'seller-a.eth', '-n', 'sepolia-v2', '--json'],
      {
        env: loadEnv({ ENSMAP_FIXTURES: 'off' }),
        fetch: historyDown,
        sleep: () => Promise.resolve(),
        now: () => NOW,
      },
    );

    expect(code).toBe(0);
    expect(historyCalls).toBeGreaterThan(0);
    const map = NameMapJson.parse(JSON.parse(stdout));
    expect(map.bindings.map((binding) => binding.windowSource)).toEqual([
      'registration',
      'registration',
    ]);
    const warning = map.warnings.find((line) =>
      line.startsWith('record history unavailable'),
    );
    expect(warning).toMatch(
      /^record history unavailable from ens-dev-graphql \(.+\); bindings use the registration date$/,
    );
  });
});

/* Human format */

function name(raw: string): InterpretedName {
  const parsed = parseNameInput(raw);
  if (!parsed.ok) {
    throw new Error(`invalid test name ${raw}`);
  }
  return parsed.name;
}

function record(
  id: string,
  canonical: string,
  overrides: Partial<DomainRecord> = {},
): DomainRecord {
  return {
    id,
    label: canonical.split('.')[0] ?? '',
    canonicalName: name(canonical),
    protocol: 'v2',
    registry: null,
    subregistry: null,
    owner: null,
    indexedResolver: null,
    indexedEthAddress: null,
    registeredAt: null,
    expiresAt: null,
    expired: false,
    ...overrides,
  };
}

function node(
  rec: DomainRecord,
  path: string,
  parentIds: string[],
  level: number,
): TreeNode {
  return { record: rec, name: name(path), aliasNames: [], parentIds, level };
}

const W: Address = `0x1234${'0'.repeat(32)}abcd`;
const W2: Address = `0xfeed${'0'.repeat(32)}beef`;
const ENCODED = `[${'ab'.repeat(32)}]`;

function fakeMap(): NameMapResult {
  const nodes = new Map<string, TreeNode>([
    ['r', node(record('r', 'r.eth', { owner: W }), 'r.eth', [], 0)],
    ['h', node(record('h', '❤.r.eth'), '❤.r.eth', ['r'], 1)],
    ['k', node(record('k', 'k.v.eth'), 'k.r.eth', ['r'], 1)],
    ['x', node(record('x', 'x.r.eth'), 'x.r.eth', ['r', 'h'], 1)],
    [
      'e',
      node(record('e', `${ENCODED}.❤.r.eth`), `${ENCODED}.❤.r.eth`, ['h'], 2),
    ],
  ]);
  const binding = (nameId: string, address: Address, verified: boolean) => ({
    nameId,
    name: nodes.get(nameId)?.name ?? name('r.eth'),
    chainId: 1,
    address,
    resolver: null,
    verified,
    verifiedBy: verified ? ('owner' as const) : null,
    validFrom: null,
    validTo: null,
    windowSource: 'unknown' as const,
    source: 'fake',
  });
  return {
    namespace: 'sepolia-v2',
    root: name('r.eth'),
    tree: {
      rootId: 'r',
      nodes,
      truncated: true,
      indexedTotal: { value: 9, exact: false },
      externalReferrers: new Map([['r', [name('v.eth')]]]),
    },
    resolutions: new Map(),
    bindings: [
      binding('r', W, true),
      binding('h', W, false),
      binding('x', W2, true),
    ],
    wallets: new Map([
      [W, { address: W, homeNameId: 'r', memberNameIds: ['r', 'h'] }],
      [W2, { address: W2, homeNameId: 'x', memberNameIds: ['x'] }],
    ]),
    tags: new Map([
      ['r', []],
      ['h', []],
      ['k', ['alias-path']],
      ['x', ['expired']],
      ['e', ['unresolvable']],
    ]),
    calls: { fake: 3 },
    warnings: [
      'keyless public RPC: rate-limited; set ALCHEMY_API_KEY or RPC_URL_11155111',
      'walk truncated at 5 names or 16 levels',
    ],
  };
}

describe('formatTree', () => {
  it('prints an indented tree of beautified names with a footer', () => {
    expect(formatTree(fakeMap())).toMatchInlineSnapshot(`
      "r.eth · 0x1234…abcd · verified · home · registry shared with: v.eth
        k.r.eth · no wallet · canonical: k.v.eth · tags: alias-path
        x.r.eth · 0xfeed…beef · verified · home · also under: ❤️.r.eth · tags: expired
        ❤️.r.eth · 0x1234…abcd · unverified · same wallet as r.eth
          [abababababababababababababababababababababababababababababababab].❤️.r.eth · no wallet · tags: unresolvable
      5 names (indexed: ≥9) · truncated: yes · wallets: 2
      warning: keyless public RPC: rate-limited; set ALCHEMY_API_KEY or RPC_URL_11155111
      warning: walk truncated at 5 names or 16 levels
      "
    `);
  });
});
