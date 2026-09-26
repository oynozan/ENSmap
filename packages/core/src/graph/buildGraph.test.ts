import { describe, expect, it } from 'vitest';

import {
  beautifyName,
  parseNameInput,
  type InterpretedName,
} from '../ens/names.ts';
import type { Binding } from '../names/bindings.ts';
import type { NameMapResult } from '../names/buildNameMap.ts';
import type { WalletGroup } from '../names/homes.ts';
import type { Address, TreeNode } from '../names/types.ts';
import { Graph, type GraphNode } from '../schema/index.ts';
import { buildGraph } from './buildGraph.ts';

function name(raw: string): InterpretedName {
  const parsed = parseNameInput(raw);
  if (!parsed.ok) {
    throw new Error(`invalid test name ${raw}`);
  }
  return parsed.name;
}

function addr(byte: string): Address {
  return `0x${byte.repeat(20)}`;
}

const W = addr('aa');
const V = addr('bb');
const OWNER = addr('cc');
const COMPUTED_AT = new Date('2026-09-26T00:00:00.000Z');
const OPTS = { computedAt: COMPUTED_AT, fetchCap: 1000 };

interface NodeSpec {
  id: string;
  path: string;
  parents?: string[];
  canonical?: string;
  owner?: Address;
  tags?: string[];
}

interface MapSpec {
  bindings?: Binding[];
  wallets?: WalletGroup[];
  referrers?: [string, string[]][];
  truncated?: boolean;
  warnings?: string[];
}

function treeNode(spec: NodeSpec): TreeNode {
  const path = name(spec.path);
  return {
    record: {
      id: spec.id,
      label: spec.path.split('.')[0] ?? '',
      canonicalName: name(spec.canonical ?? spec.path),
      protocol: 'v2',
      registry: null,
      subregistry: null,
      owner: spec.owner ?? null,
      indexedResolver: null,
      indexedEthAddress: null,
      registeredAt: null,
      expiresAt: null,
      expired: false,
    },
    name: path,
    aliasNames: [],
    parentIds: spec.parents ?? [],
    level: spec.path.split('.').length - 2,
  };
}

// The first spec is the root
function nameMap(specs: NodeSpec[], extra: MapSpec = {}): NameMapResult {
  const nodes = new Map(specs.map((spec) => [spec.id, treeNode(spec)]));
  const root = specs[0];
  if (root === undefined) {
    throw new Error('a name map needs a root');
  }
  return {
    namespace: 'sepolia-v2',
    root: name(root.path),
    tree: {
      rootId: root.id,
      nodes,
      truncated: extra.truncated ?? false,
      indexedTotal: { value: specs.length, exact: true },
      externalReferrers: new Map(
        (extra.referrers ?? []).map(([id, names]) => [id, names.map(name)]),
      ),
    },
    resolutions: new Map(),
    bindings: extra.bindings ?? [],
    wallets: new Map(
      (extra.wallets ?? []).map((group) => [group.address, group]),
    ),
    tags: new Map(specs.map((spec) => [spec.id, spec.tags ?? []])),
    calls: {},
    warnings: extra.warnings ?? [],
  };
}

function bind(
  nameId: string,
  address: Address,
  verifiedBy: Binding['verifiedBy'],
): Binding {
  return {
    nameId,
    name: name(`${nameId}.eth`),
    chainId: 11155111,
    address,
    resolver: null,
    verified: verifiedBy !== null,
    verifiedBy,
    validFrom: null,
    validTo: null,
    windowSource: 'unknown',
    source: 'test',
  };
}

function nodeOf(graph: Graph, id: string): GraphNode {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`no node ${id}`);
  }
  return node;
}

function sharedRegistry(): NameMapResult {
  return nameMap([
    { id: 'r', path: 'r.eth' },
    { id: 'a', path: 'a.r.eth', parents: ['r'] },
    { id: 'b', path: 'b.r.eth', parents: ['r'] },
    { id: 'x', path: 'x.a.r.eth', parents: ['a', 'b'] },
  ]);
}

describe('buildGraph', () => {
  it('makes the root and wallet home names name bubbles, the rest subnames', () => {
    const graph = buildGraph(
      nameMap(
        [
          { id: 'r', path: 'r.eth' },
          { id: 'a', path: 'a.r.eth', parents: ['r'] },
          { id: 'b', path: 'b.r.eth', parents: ['r'] },
        ],
        {
          bindings: [bind('a', W, 'primary-name'), bind('b', W, null)],
          wallets: [{ address: W, homeNameId: 'a', memberNameIds: ['b', 'a'] }],
        },
      ),
      OPTS,
    );

    expect(graph.nodes.map((node) => [node.id, node.kind])).toEqual([
      ['r', 'name'],
      ['a', 'name'],
      ['b', 'subname'],
    ]);
    const b = nodeOf(graph, 'b');
    expect(b.address).toBe(W);
    expect(b.names).toEqual(['a', 'b']);
    expect(b.homeName).toBe('a');
    expect(nodeOf(graph, 'a').names).toEqual(['a', 'b']);
  });

  it('adds one edge per parent in a shared registry and counts distinct descendants', () => {
    const graph = buildGraph(sharedRegistry(), OPTS);

    expect(graph.edges).toEqual([
      {
        id: 'subname:a:x',
        source: 'a',
        target: 'x',
        kind: 'subname',
        directed: true,
      },
      {
        id: 'subname:b:x',
        source: 'b',
        target: 'x',
        kind: 'subname',
        directed: true,
      },
      {
        id: 'subname:r:a',
        source: 'r',
        target: 'a',
        kind: 'subname',
        directed: true,
      },
      {
        id: 'subname:r:b',
        source: 'r',
        target: 'b',
        kind: 'subname',
        directed: true,
      },
    ]);
    expect(nodeOf(graph, 'r').size).toEqual({
      metric: 'subnamesHeld',
      value: 3,
    });
    expect(nodeOf(graph, 'a').size.value).toBe(1);
    expect(nodeOf(graph, 'b').size.value).toBe(1);
    expect(nodeOf(graph, 'x').size.value).toBe(0);
  });

  it('drops a self-parent edge and tags the node self-parent', () => {
    const graph = buildGraph(
      nameMap([
        { id: 't', path: 't.eth' },
        { id: 'y', path: 'y.t.eth', parents: ['t', 'y'], tags: ['expired'] },
      ]),
      OPTS,
    );

    expect(graph.edges.map((edge) => edge.id)).toEqual(['subname:t:y']);
    const y = nodeOf(graph, 'y');
    expect(y.tags).toEqual(['expired', 'self-parent']);
    expect(y.size.value).toBe(0);
    expect(nodeOf(graph, 't').size.value).toBe(1);
    expect(nodeOf(graph, 't').tags).toEqual([]);
  });

  it('counts each descendant once around a registry cycle', () => {
    const graph = buildGraph(
      nameMap([
        { id: 'r', path: 'r.eth' },
        { id: 'a', path: 'a.r.eth', parents: ['r', 'b'] },
        { id: 'b', path: 'b.a.r.eth', parents: ['a'] },
      ]),
      OPTS,
    );

    expect(graph.edges.map((edge) => edge.id)).toEqual([
      'subname:a:b',
      'subname:b:a',
      'subname:r:a',
    ]);
    expect(nodeOf(graph, 'r').size.value).toBe(2);
    expect(nodeOf(graph, 'a').size.value).toBe(1);
    expect(nodeOf(graph, 'b').size.value).toBe(1);
  });

  it('skips a parent outside the tree', () => {
    const graph = buildGraph(
      nameMap([
        { id: 'r', path: 'r.eth' },
        { id: 'a', path: 'a.r.eth', parents: ['r', 'elsewhere'] },
      ]),
      OPTS,
    );

    expect(graph.edges.map((edge) => edge.id)).toEqual(['subname:r:a']);
  });

  it('sets canonical only on alias-path nodes', () => {
    const graph = buildGraph(
      nameMap([
        { id: 'r', path: 'seller-a.eth' },
        {
          id: 'alias',
          path: 'agent-2.seller-a.eth',
          parents: ['r'],
          canonical: 'agent-2.vet402.eth',
          tags: ['alias-path', 'alias-unresolved'],
        },
        { id: 'own', path: 'agent-1.seller-a.eth', parents: ['r'] },
      ]),
      OPTS,
    );

    expect(nodeOf(graph, 'alias').canonical).toBe('agent-2.vet402.eth');
    expect(nodeOf(graph, 'own')).not.toHaveProperty('canonical');
    expect(nodeOf(graph, 'r')).not.toHaveProperty('canonical');
  });

  it('lists the names outside the tree that share a registry', () => {
    const graph = buildGraph(
      nameMap(
        [
          { id: 'r', path: 'seller-a.eth' },
          { id: 'a', path: 'a.seller-a.eth', parents: ['r'] },
        ],
        {
          referrers: [
            ['r', ['vet402.eth']],
            ['a', []],
          ],
        },
      ),
      OPTS,
    );

    expect(nodeOf(graph, 'r').sharedWith).toEqual(['vet402.eth']);
    expect(nodeOf(graph, 'a')).not.toHaveProperty('sharedWith');
  });

  it('beautifies labels, canonical names and registry sharers', () => {
    const heart = name('❤.eth');
    const graph = buildGraph(
      nameMap(
        [
          { id: 'r', path: '❤.eth' },
          {
            id: 'a',
            path: 'a.❤.eth',
            parents: ['r'],
            canonical: 'a.❤.v.eth',
            tags: ['alias-path'],
          },
        ],
        { referrers: [['r', ['❤.eth']]] },
      ),
      OPTS,
    );

    const root = nodeOf(graph, 'r');
    expect(root.label).toBe(beautifyName(heart));
    expect(root.label).not.toBe('❤.eth');
    expect(root.sharedWith).toEqual([beautifyName(heart)]);
    expect(nodeOf(graph, 'a').canonical).toBe(beautifyName(name('a.❤.v.eth')));
  });

  it('copies the binding and owner, and leaves wallet fields off unbound nodes', () => {
    const graph = buildGraph(
      nameMap(
        [
          { id: 'r', path: 'r.eth', owner: OWNER },
          { id: 'a', path: 'a.r.eth', parents: ['r'] },
          { id: 'b', path: 'b.r.eth', parents: ['r'] },
        ],
        {
          bindings: [bind('r', OWNER, 'owner'), bind('a', V, null)],
          wallets: [
            { address: OWNER, homeNameId: 'r', memberNameIds: ['r'] },
            { address: V, homeNameId: 'a', memberNameIds: ['a'] },
          ],
        },
      ),
      OPTS,
    );

    expect(nodeOf(graph, 'r')).toMatchObject({
      address: OWNER,
      verified: true,
      verifiedBy: 'owner',
      chainId: 11155111,
      owner: OWNER,
      names: ['r'],
      homeName: 'r',
    });
    const a = nodeOf(graph, 'a');
    expect(a.verified).toBe(false);
    expect(a).not.toHaveProperty('verifiedBy');
    expect(a).not.toHaveProperty('owner');
    const b = nodeOf(graph, 'b');
    for (const field of [
      'address',
      'names',
      'homeName',
      'verified',
      'verifiedBy',
      'chainId',
    ]) {
      expect(b).not.toHaveProperty(field);
    }
  });

  it('fills meta from the name map and the options', () => {
    const graph = buildGraph(
      nameMap(
        [
          { id: 'r', path: 'r.eth' },
          { id: 'a', path: 'a.r.eth', parents: ['r'] },
        ],
        {
          bindings: [bind('a', W, 'primary-name')],
          wallets: [{ address: W, homeNameId: 'a', memberNameIds: ['a'] }],
          truncated: true,
          warnings: ['walk truncated at 2 names or 16 levels'],
        },
      ),
      { computedAt: COMPUTED_AT, fetchCap: 2 },
    );

    expect(graph.version).toBe(1);
    expect(graph.meta).toEqual({
      namespace: 'sepolia-v2',
      root: 'r',
      computedAt: '2026-09-26T00:00:00.000Z',
      caps: { fetch: 2 },
      filters: {},
      totals: { names: 2, indexed: { value: 2, exact: true }, wallets: 1 },
      truncated: ['names'],
      warnings: ['walk truncated at 2 names or 16 levels'],
    });
    expect(buildGraph(sharedRegistry(), OPTS).meta.truncated).toEqual([]);
  });

  it('keeps tree order for nodes, parses with Graph and is deterministic', () => {
    const r = nameMap(
      [
        { id: 'r', path: 'r.eth', owner: OWNER },
        { id: 'z', path: 'z.r.eth', parents: ['r'], tags: ['expired'] },
        { id: 'a', path: 'a.r.eth', parents: ['r'] },
        { id: 'm', path: 'm.z.r.eth', parents: ['z', 'a', 'm'] },
      ],
      {
        bindings: [bind('z', W, 'primary-name'), bind('m', W, null)],
        wallets: [{ address: W, homeNameId: 'z', memberNameIds: ['z', 'm'] }],
        referrers: [['r', ['v.eth']]],
      },
    );

    const graph = buildGraph(r, OPTS);

    expect(graph.nodes.map((node) => node.id)).toEqual(['r', 'z', 'a', 'm']);
    expect(Graph.parse(graph)).toEqual(graph);
    expect(buildGraph(r, OPTS)).toEqual(graph);
  });
});
