import { describe, expect, it } from 'vitest';

import { parseNameInput, type InterpretedName } from '../ens/names.ts';
import type { Binding } from './bindings.ts';
import { assignHomeNames, type WalletGroup } from './homes.ts';
import type { Address, DomainRecord, NameTree, TreeNode } from './types.ts';

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
const U = addr('cc');
const CHECKSUMMED: Address = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const LOWER: Address = '0xabcdef0123456789abcdef0123456789abcdef01';

function treeNode(
  rawName: string,
  overrides: { canonicalName?: string; aliasNames?: string[] } = {},
): TreeNode {
  const nodeName = name(rawName);
  const record: DomainRecord = {
    id: `id:${rawName}`,
    label: rawName.split('.')[0] ?? '',
    canonicalName:
      overrides.canonicalName === undefined
        ? null
        : name(overrides.canonicalName),
    protocol: 'v2',
    registry: null,
    subregistry: null,
    owner: null,
    indexedResolver: null,
    indexedEthAddress: null,
    registeredAt: null,
    expiresAt: null,
    expired: false,
  };
  return {
    record,
    name: nodeName,
    aliasNames: (overrides.aliasNames ?? []).map(name),
    parentIds: [],
    level: nodeName.split('.').length - 2,
  };
}

function treeOf(nodes: readonly TreeNode[]): NameTree {
  return {
    rootId: nodes[0]?.record.id ?? '',
    nodes: new Map(nodes.map((node) => [node.record.id, node])),
    truncated: false,
    indexedTotal: { value: nodes.length, exact: true },
    externalReferrers: new Map(),
  };
}

function bind(node: TreeNode, address: Address, chainId = 1): Binding {
  return {
    nameId: node.record.id,
    name: node.name,
    chainId,
    address,
    resolver: null,
    verified: false,
    verifiedBy: null,
    validFrom: null,
    validTo: null,
    windowSource: 'unknown',
    source: 'test',
  };
}

function id(rawName: string): string {
  return `id:${rawName}`;
}

function primaries(
  entries: [Address, string | null][] = [],
): Map<Address, InterpretedName | null> {
  return new Map(
    entries.map(([address, primary]) => [
      address,
      primary === null ? null : name(primary),
    ]),
  );
}

function groupOf(groups: Map<Address, WalletGroup>, address: Address) {
  const group = groups.get(address);
  if (group === undefined) {
    throw new Error(`no group for ${address}`);
  }
  return group;
}

// Deterministic permutations, so a failure reproduces
function permutations<T>(items: readonly T[], count: number): T[][] {
  let seed = 7;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const result: T[][] = [[...items], [...items].reverse()];
  while (result.length < count) {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j] as T, shuffled[i] as T];
    }
    result.push(shuffled);
  }
  return result;
}

const root = treeNode('r.eth');
const a = treeNode('a.r.eth');
const b = treeNode('b.r.eth');
const xa = treeNode('x.a.r.eth');

describe('assignHomeNames', () => {
  it('makes an in-scope primary name the home over a shallower name', () => {
    const groups = assignHomeNames(
      [bind(a, W), bind(xa, W)],
      treeOf([root, a, xa]),
      primaries([[W, 'x.a.r.eth']]),
    );
    expect(groupOf(groups, W).homeNameId).toBe(id('x.a.r.eth'));
  });

  it.each([
    ['canonical name', { canonicalName: 'y.s.eth' }, 'y.s.eth'],
    ['alias', { aliasNames: ['y.b.r.eth'] }, 'y.b.r.eth'],
  ])('counts a primary name that matches the %s', (_, overrides, primary) => {
    const y = treeNode('y.a.r.eth', overrides);
    const groups = assignHomeNames(
      [bind(a, W), bind(y, W)],
      treeOf([root, a, y]),
      primaries([[W, primary]]),
    );
    expect(groupOf(groups, W).homeNameId).toBe(id('y.a.r.eth'));
  });

  it('falls back to the shallowest name when the primary name is out of scope', () => {
    const ab = treeNode('a.b.r.eth');
    const tree = treeOf([root, ab, b]);
    const bindings = [bind(ab, W), bind(b, W)];
    for (const primary of ['elsewhere.eth', null]) {
      const groups = assignHomeNames(bindings, tree, primaries([[W, primary]]));
      expect(groupOf(groups, W).homeNameId).toBe(id('b.r.eth'));
    }
    expect(
      groupOf(assignHomeNames(bindings, tree, primaries()), W).homeNameId,
    ).toBe(id('b.r.eth'));
  });

  it('breaks a depth tie by the code-point order of the first label', () => {
    // U+FA0E sorts before U+1F600 by code point, but after it by UTF-16 unit
    const emoji = treeNode('😀.r.eth');
    const cjk = treeNode('﨎.r.eth');
    const groups = assignHomeNames(
      [bind(emoji, W), bind(cjk, W)],
      treeOf([root, emoji, cjk]),
      primaries(),
    );
    expect(groupOf(groups, W).homeNameId).toBe(id('﨎.r.eth'));
  });

  it('compares first labels before whole names', () => {
    // By whole name 'a-.c' sorts first, since '-' is below '.'
    const short = treeNode('a.z.r.eth');
    const hyphen = treeNode('a-.c.r.eth');
    const groups = assignHomeNames(
      [bind(hyphen, W), bind(short, W)],
      treeOf([root, short, hyphen]),
      primaries(),
    );
    expect(groupOf(groups, W).homeNameId).toBe(id('a.z.r.eth'));
  });

  it('breaks a first-label tie by the whole name', () => {
    const xb = treeNode('x.b.r.eth');
    const groups = assignHomeNames(
      [bind(xb, W), bind(xa, W)],
      treeOf([root, xa, xb]),
      primaries(),
    );
    expect(groupOf(groups, W).homeNameId).toBe(id('x.a.r.eth'));
  });

  it('picks by name order when several nodes match the primary name', () => {
    const q = treeNode('q.a.r.eth', { canonicalName: 'b.r.eth' });
    const groups = assignHomeNames(
      [bind(q, W), bind(b, W), bind(a, W)],
      treeOf([root, a, q, b]),
      primaries([[W, 'b.r.eth']]),
    );
    expect(groupOf(groups, W).homeNameId).toBe(id('b.r.eth'));
  });

  it('groups mixed-case addresses under the lowercase address', () => {
    const groups = assignHomeNames(
      [bind(xa, CHECKSUMMED), bind(a, LOWER)],
      treeOf([root, a, xa]),
      primaries([[CHECKSUMMED, 'x.a.r.eth']]),
    );
    expect([...groups]).toEqual([
      [
        LOWER,
        {
          address: LOWER,
          homeNameId: id('x.a.r.eth'),
          memberNameIds: [id('a.r.eth'), id('x.a.r.eth')],
        },
      ],
    ]);
  });

  it('makes a single-name wallet its own home', () => {
    const groups = assignHomeNames(
      [bind(b, V)],
      treeOf([root, b]),
      primaries([[V, 'elsewhere.eth']]),
    );
    expect(groups.get(V)).toEqual({
      address: V,
      homeNameId: id('b.r.eth'),
      memberNameIds: [id('b.r.eth')],
    });
  });

  it('lists a name bound on several chains once', () => {
    const groups = assignHomeNames(
      [bind(a, W, 1), bind(a, W, 8453), bind(b, W, 1)],
      treeOf([root, a, b]),
      primaries(),
    );
    expect(groupOf(groups, W).memberNameIds).toEqual([
      id('a.r.eth'),
      id('b.r.eth'),
    ]);
  });

  it('includes unverified bindings', () => {
    const groups = assignHomeNames(
      [bind(a, W)],
      treeOf([root, a]),
      primaries(),
    );
    expect(groupOf(groups, W).homeNameId).toBe(id('a.r.eth'));
  });

  it('returns no groups for no bindings', () => {
    expect(assignHomeNames([], treeOf([root]), primaries()).size).toBe(0);
  });

  it('rejects a binding whose name is not in the tree', () => {
    expect(() =>
      assignHomeNames([bind(a, W)], treeOf([root]), primaries()),
    ).toThrow(/id:a\.r\.eth/);
  });

  describe('over several wallets', () => {
    const emoji = treeNode('😀.r.eth');
    const cjk = treeNode('﨎.r.eth');
    const c = treeNode('c.r.eth');
    const yb = treeNode('y.b.r.eth', { canonicalName: 'y.s.eth' });
    const nodes = [root, a, b, c, xa, emoji, cjk, yb];
    const tree = treeOf(nodes);
    const bindings = [
      bind(xa, W),
      bind(a, W),
      bind(emoji, W),
      bind(root, V),
      bind(yb, V),
      bind(cjk, U),
      bind(b, CHECKSUMMED),
      bind(c, LOWER),
    ];
    const primaryNames = primaries([
      [W, 'x.a.r.eth'],
      [V, 'y.s.eth'],
      [U, null],
    ]);

    it('gives the same output for shuffled input', () => {
      const expected = [...assignHomeNames(bindings, tree, primaryNames)];
      for (const shuffled of permutations(bindings, 8)) {
        expect([...assignHomeNames(shuffled, tree, primaryNames)]).toEqual(
          expected,
        );
      }
    });

    it('orders wallets by address and members by name', () => {
      expect([...assignHomeNames(bindings, tree, primaryNames)]).toEqual([
        [
          W,
          {
            address: W,
            homeNameId: id('x.a.r.eth'),
            memberNameIds: [id('a.r.eth'), id('😀.r.eth'), id('x.a.r.eth')],
          },
        ],
        [
          LOWER,
          {
            address: LOWER,
            homeNameId: id('b.r.eth'),
            memberNameIds: [id('b.r.eth'), id('c.r.eth')],
          },
        ],
        [
          V,
          {
            address: V,
            homeNameId: id('y.b.r.eth'),
            memberNameIds: [id('r.eth'), id('y.b.r.eth')],
          },
        ],
        [
          U,
          {
            address: U,
            homeNameId: id('﨎.r.eth'),
            memberNameIds: [id('﨎.r.eth')],
          },
        ],
      ]);
    });

    it('gives each wallet one home among exactly its bound names', () => {
      const groups = assignHomeNames(bindings, tree, primaryNames);
      const boundTo = new Map<string, Set<string>>();
      for (const binding of bindings) {
        const key = binding.address.toLowerCase();
        const ids = boundTo.get(key) ?? new Set<string>();
        ids.add(binding.nameId);
        boundTo.set(key, ids);
      }
      expect([...groups.keys()].sort()).toEqual([...boundTo.keys()].sort());
      for (const [address, group] of groups) {
        expect(group.address).toBe(address);
        expect(group.memberNameIds).toContain(group.homeNameId);
        expect(new Set(group.memberNameIds).size).toBe(
          group.memberNameIds.length,
        );
        expect(new Set(group.memberNameIds)).toEqual(boundTo.get(address));
      }
      const members = [...groups.values()].flatMap(
        (group) => group.memberNameIds,
      );
      expect(members.toSorted()).toEqual(
        [...new Set(bindings.map((binding) => binding.nameId))].toSorted(),
      );
    });
  });
});
