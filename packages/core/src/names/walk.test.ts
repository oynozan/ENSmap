import { describe, expect, it } from 'vitest';

import { parseNameInput, type InterpretedName } from '../ens/names.ts';
import {
  createFakeNameSource,
  type FakeCall,
  type FakeDomain,
  type FakeNameSource,
} from './testing/fakeNameSource.ts';
import type { Address, NameSource, NameTree, TreeNode } from './types.ts';
import { NameNotFoundError, walkTree } from './walk.ts';

const OPTS = { fetchCap: 1000, maxLevels: 16 };

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

const ROOT_REG = addr('01');
const R = addr('11');
const B = addr('22');
const S = addr('33');

function node(tree: NameTree, id: string): TreeNode {
  const found = tree.nodes.get(id);
  if (found === undefined) {
    throw new Error(`no node ${id}`);
  }
  return found;
}

type ListCall = Extract<FakeCall, { method: 'listChildren' }>;

function listCalls(source: FakeNameSource): ListCall[] {
  return source.calls.filter(
    (call): call is ListCall => call.method === 'listChildren',
  );
}

function referrerCalls(source: FakeNameSource): Address[] {
  return source.calls.flatMap((call) =>
    call.method === 'registryReferrers' ? [call.registry] : [],
  );
}

function v2(
  id: string,
  label: string,
  canonicalName: string,
  registry: Address | null,
  subregistry: Address | null,
): FakeDomain {
  return { id, label, canonicalName, protocol: 'v2', registry, subregistry };
}

// r -> a, b sharing subregistry R, which holds x
function sharedRegistryDomains(): FakeDomain[] {
  return [
    v2('r', 'r', 'r', null, ROOT_REG),
    v2('a', 'a', 'a.r', ROOT_REG, R),
    v2('b', 'b', 'b.r', ROOT_REG, R),
    v2('x', 'x', 'x.a.r', R, null),
  ];
}

// r -> t with subregistry R, and R holds y whose subregistry is R again
function selfReferentialDomains(): FakeDomain[] {
  return [
    v2('r', 'r', 'r', null, ROOT_REG),
    v2('t', 't', 't.r', ROOT_REG, R),
    v2('y', 'y', 'y.t.r', R, R),
  ];
}

describe('walkTree', () => {
  describe('multiple parents', () => {
    it('lists a shared registry once and gives its child one edge per parent', async () => {
      const source = createFakeNameSource({
        domains: sharedRegistryDomains(),
        children: { [ROOT_REG]: ['b', 'a'], [R]: ['x'] },
      });

      const tree = await walkTree(source, name('r'), OPTS);

      expect(tree.nodes.size).toBe(4);
      expect(node(tree, 'x')).toMatchObject({
        name: 'x.a.r',
        aliasNames: ['x.b.r'],
        parentIds: ['a', 'b'],
        level: 2,
      });
      expect(node(tree, 'a')).toMatchObject({ parentIds: ['r'], level: 1 });
      expect(listCalls(source)).toEqual([
        { method: 'listChildren', parents: ['r'], cursor: null },
        { method: 'listChildren', parents: ['a'], cursor: null },
        { method: 'listChildren', parents: ['x'], cursor: null },
      ]);
    });

    it('lists a key through its first parent in code-point name order', async () => {
      // UTF-16 order puts 😀 first, code-point order puts 﨎 first
      const source = createFakeNameSource({
        domains: [
          v2('r', 'r', 'r', null, ROOT_REG),
          v2('smile', '😀', '😀.r', ROOT_REG, R),
          v2('cjk', '﨎', '﨎.r', ROOT_REG, R),
          v2('x', 'x', 'x.﨎.r', R, null),
        ],
        children: { [ROOT_REG]: ['smile', 'cjk'], [R]: ['x'] },
      });

      const tree = await walkTree(source, name('r'), OPTS);

      expect(listCalls(source)[1]?.parents).toEqual(['cjk']);
      expect(node(tree, 'x')).toMatchObject({
        name: 'x.﨎.r',
        aliasNames: ['x.😀.r'],
        parentIds: ['cjk', 'smile'],
      });
    });

    it('fans a listed key out to a parent found on a later level without listing it again', async () => {
      const source = createFakeNameSource({
        domains: [
          v2('r', 'r', 'r', null, ROOT_REG),
          v2('a', 'a', 'a.r', ROOT_REG, R),
          v2('b', 'b', 'b.r', ROOT_REG, B),
          v2('c', 'c', 'c.b.r', B, R),
          v2('x', 'x', 'x.a.r', R, null),
        ],
        children: { [ROOT_REG]: ['a', 'b'], [B]: ['c'], [R]: ['x'] },
      });

      const tree = await walkTree(source, name('r'), OPTS);

      expect(tree.nodes.size).toBe(5);
      expect(node(tree, 'x')).toMatchObject({
        name: 'x.a.r',
        aliasNames: ['x.c.b.r'],
        parentIds: ['a', 'c'],
        level: 2,
      });
      expect(listCalls(source).map((call) => call.parents)).toEqual([
        ['r'],
        ['a', 'b'],
        ['x'],
      ]);
    });
  });

  describe('cycles', () => {
    it('terminates on a registry that holds its own parent', async () => {
      const source = createFakeNameSource({
        domains: selfReferentialDomains(),
        children: { [ROOT_REG]: ['t'], [R]: ['y'] },
      });

      const tree = await walkTree(source, name('r'), OPTS);

      expect(tree.nodes.size).toBe(3);
      expect(node(tree, 'y')).toMatchObject({
        name: 'y.t.r',
        aliasNames: ['y.y.t.r'],
        parentIds: ['t', 'y'],
        level: 2,
      });
      expect(listCalls(source).map((call) => call.parents)).toEqual([
        ['r'],
        ['t'],
      ]);
      expect(tree.truncated).toBe(false);
    });

    it('keeps a single root that lives in its own subregistry and counts it once', async () => {
      const source = createFakeNameSource({
        domains: [v2('tiny', 'tiny', 'tiny.test', R, R)],
        children: { [R]: ['tiny'] },
        reportTotals: true,
      });

      const tree = await walkTree(source, name('tiny.test'), OPTS);

      expect(tree.rootId).toBe('tiny');
      expect(tree.nodes.size).toBe(1);
      expect(node(tree, 'tiny')).toMatchObject({
        name: 'tiny.test',
        aliasNames: ['tiny.tiny.test'],
        parentIds: ['tiny'],
        level: 0,
      });
      expect(tree.indexedTotal).toEqual({ value: 1, exact: true });
    });
  });

  describe('caps', () => {
    it('stops at fetchCap and processes fetched children in label order', async () => {
      const ids = Array.from(
        { length: 1500 },
        (_, i) => `c${String(i).padStart(4, '0')}`,
      );
      const source = createFakeNameSource({
        domains: [
          { id: 'r', label: 'r', canonicalName: 'r' },
          ...ids.map((id) => ({ id, label: id })),
        ],
        children: { r: [...ids].reverse() },
        pageSize: 200,
        reportTotals: true,
      });

      const tree = await walkTree(source, name('r'), OPTS);

      expect(tree.nodes.size).toBe(1000);
      expect(tree.truncated).toBe(true);
      expect(listCalls(source).map((call) => call.cursor)).toEqual([
        null,
        '200',
        '400',
        '600',
        '800',
      ]);
      expect(tree.indexedTotal).toEqual({ value: 1501, exact: false });
      // Fetched c1499..c0500, and the largest label is the one dropped
      expect(tree.nodes.has('c0500')).toBe(true);
      expect(tree.nodes.has('c1498')).toBe(true);
      expect(tree.nodes.has('c1499')).toBe(false);
    });

    it('is not truncated when the tree fits fetchCap exactly', async () => {
      const source = createFakeNameSource({
        domains: [
          { id: 'r', label: 'r', canonicalName: 'r' },
          { id: 'a', label: 'a' },
          { id: 'b', label: 'b' },
        ],
        children: { r: ['a', 'b'] },
      });

      const tree = await walkTree(source, name('r'), {
        fetchCap: 3,
        maxLevels: 16,
      });

      expect(tree.nodes.size).toBe(3);
      expect(tree.truncated).toBe(false);
      expect(listCalls(source).map((call) => call.parents)).toEqual([
        ['r'],
        ['a', 'b'],
      ]);
    });

    it('stops maxLevels below the root on a longer chain', async () => {
      const labels = Array.from({ length: 19 }, (_, i) => `l${i + 1}`);
      const children: Record<string, string[]> = {};
      ['r', ...labels].forEach((id, i) => {
        const child = labels[i];
        if (child !== undefined) {
          children[id] = [child];
        }
      });
      const source = createFakeNameSource({
        domains: [
          { id: 'r', label: 'r', canonicalName: 'r' },
          ...labels.map((id) => ({ id, label: id })),
        ],
        children,
      });

      const tree = await walkTree(source, name('r'), OPTS);

      expect(tree.nodes.size).toBe(17);
      expect(tree.truncated).toBe(true);
      expect(node(tree, 'l16').level).toBe(16);
      expect(tree.nodes.has('l17')).toBe(false);
      expect(listCalls(source)).toHaveLength(17);
    });

    it('adds edges but no nodes at the maxLevels boundary', async () => {
      const source = createFakeNameSource({
        domains: selfReferentialDomains(),
        children: { [ROOT_REG]: ['t'], [R]: ['y'] },
      });

      const tree = await walkTree(source, name('r'), {
        fetchCap: 1000,
        maxLevels: 2,
      });

      expect(tree.nodes.size).toBe(3);
      expect(tree.truncated).toBe(false);
      expect(node(tree, 'y').parentIds).toEqual(['t', 'y']);
    });

    it('is truncated when a new child exists below the maxLevels boundary', async () => {
      const source = createFakeNameSource({
        domains: selfReferentialDomains(),
        children: { [ROOT_REG]: ['t'], [R]: ['y'] },
      });

      const tree = await walkTree(source, name('r'), {
        fetchCap: 1000,
        maxLevels: 1,
      });

      expect([...tree.nodes.keys()]).toEqual(['r', 't']);
      expect(tree.truncated).toBe(true);
    });

    it('lists the maxLevels boundary only until the first new child', async () => {
      const deep = Array.from({ length: 450 }, (_, i) => `d${i}`);
      const source = createFakeNameSource({
        domains: [
          { id: 'r', label: 'r', canonicalName: 'r' },
          { id: 'a', label: 'a' },
          { id: 'b', label: 'b' },
          { id: 'e', label: 'e' },
          ...deep.map((id) => ({ id, label: id })),
        ],
        children: { r: ['a', 'b'], a: deep, b: ['e'] },
        pageSize: 200,
        maxParentsPerCall: 1,
      });

      const tree = await walkTree(source, name('r'), {
        fetchCap: 1000,
        maxLevels: 1,
      });

      expect(tree.truncated).toBe(true);
      expect(listCalls(source).slice(1)).toEqual([
        { method: 'listChildren', parents: ['a'], cursor: null },
      ]);
    });

    it('rejects a fetchCap below 1 or a negative maxLevels', async () => {
      const source = createFakeNameSource({
        domains: [{ id: 'r', label: 'r', canonicalName: 'r' }],
      });

      await expect(
        walkTree(source, name('r'), { fetchCap: 0, maxLevels: 16 }),
      ).rejects.toThrow(RangeError);
      await expect(
        walkTree(source, name('r'), { fetchCap: 1000, maxLevels: -1 }),
      ).rejects.toThrow(RangeError);
      expect(source.calls).toEqual([]);
    });

    it('rejects a source whose maxParentsPerCall is below 1', async () => {
      const source = createFakeNameSource({
        domains: [{ id: 'r', label: 'r', canonicalName: 'r' }],
        maxParentsPerCall: 0,
      });

      await expect(walkTree(source, name('r'), OPTS)).rejects.toThrow(
        RangeError,
      );
    });
  });

  describe('listing', () => {
    it('follows pages until next is null', async () => {
      const ids = Array.from({ length: 450 }, (_, i) => `k${i}`);
      const source = createFakeNameSource({
        domains: [
          { id: 'r', label: 'r', canonicalName: 'r' },
          ...ids.map((id) => ({ id, label: id })),
        ],
        children: { r: ids },
        pageSize: 200,
        reportTotals: true,
      });

      const tree = await walkTree(source, name('r'), OPTS);

      expect(tree.nodes.size).toBe(451);
      expect(tree.truncated).toBe(false);
      expect(
        listCalls(source)
          .filter((call) => call.parents[0] === 'r')
          .map((call) => call.cursor),
      ).toEqual([null, '200', '400']);
      expect(tree.indexedTotal).toEqual({ value: 451, exact: true });
    });

    it('reports a lower bound when a listed key has no total', async () => {
      const source = createFakeNameSource({
        domains: [
          { id: 'r', label: 'r', canonicalName: 'r' },
          { id: 'a', label: 'a' },
        ],
        children: { r: ['a'] },
      });

      const tree = await walkTree(source, name('r'), OPTS);

      expect(tree.indexedTotal).toEqual({ value: 2, exact: false });
    });

    it.each([
      [100, 1],
      [1, 30],
    ])(
      'with maxParentsPerCall %i lists 30 v1 parents on one level in %i calls',
      async (maxParentsPerCall, expectedCalls) => {
        const ids = Array.from(
          { length: 30 },
          (_, i) => `p${String(i).padStart(2, '0')}`,
        );
        const source = createFakeNameSource({
          domains: [
            { id: 'r', label: 'r', canonicalName: 'r' },
            ...ids.map((id) => ({ id, label: id })),
          ],
          children: { r: [...ids].reverse() },
          maxParentsPerCall,
        });

        const tree = await walkTree(source, name('r'), OPTS);

        const levelOne = listCalls(source).slice(1);
        expect(tree.nodes.size).toBe(31);
        expect(levelOne).toHaveLength(expectedCalls);
        expect(levelOne.flatMap((call) => call.parents)).toEqual(ids);
      },
    );

    it('rejects a page item whose parentId was not requested', async () => {
      const fake = createFakeNameSource({
        domains: [
          { id: 'r', label: 'r', canonicalName: 'r' },
          { id: 'a', label: 'a' },
        ],
      });
      const source: NameSource = {
        ...fake,
        listChildren: () =>
          Promise.resolve({
            items: [{ parentId: 'elsewhere', record: fake.record('a') }],
            next: null,
          }),
      };

      await expect(walkTree(source, name('r'), OPTS)).rejects.toThrow(
        /elsewhere/,
      );
    });

    it('rejects a source that answers a cursor with the same cursor', async () => {
      const fake = createFakeNameSource({
        domains: [{ id: 'r', label: 'r', canonicalName: 'r' }],
      });
      let calls = 0;
      const source: NameSource = {
        ...fake,
        listChildren: () => {
          calls += 1;
          // Without a guard the walk would page forever
          return calls > 5
            ? Promise.reject(new Error('still paging'))
            : Promise.resolve({ items: [], next: 'c1' });
        },
      };

      await expect(walkTree(source, name('r'), OPTS)).rejects.toThrow(
        'fake listChildren answered cursor "c1" with the same cursor',
      );
      expect(calls).toBe(2);
    });
  });

  describe('root', () => {
    it('throws NameNotFoundError when the source has no such name', async () => {
      const source = createFakeNameSource({ domains: [] });

      const error: unknown = await walkTree(
        source,
        name('missing.eth'),
        OPTS,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NameNotFoundError);
      expect((error as NameNotFoundError).input).toBe('missing.eth');
    });

    it('names the root by its input and puts it on level 0', async () => {
      const source = createFakeNameSource({
        domains: [{ id: 'r', label: 'r', canonicalName: 'r' }],
      });

      const tree = await walkTree(source, name('r'), OPTS);

      expect(tree.rootId).toBe('r');
      expect(node(tree, 'r')).toMatchObject({
        name: 'r',
        aliasNames: [],
        parentIds: [],
        level: 0,
      });
    });
  });

  describe('registry referrers', () => {
    it('puts a referrer that is not in scope into externalReferrers', async () => {
      const source = createFakeNameSource({
        domains: [v2('r', 'r', 'r', null, R)],
        referrers: { [R]: ['r', 'other.eth'] },
      });

      const tree = await walkTree(source, name('r'), OPTS);

      expect(tree.externalReferrers).toEqual(new Map([['r', ['other.eth']]]));
    });

    it('asks once per registry and applies the answer to every node sharing it', async () => {
      const source = createFakeNameSource({
        domains: sharedRegistryDomains(),
        children: { [ROOT_REG]: ['a', 'b'], [R]: ['x'] },
        referrers: { [R]: ['zz.eth', 'b.r', 'a.r', 'c.eth', 'zz.eth'] },
      });

      const tree = await walkTree(source, name('r'), OPTS);

      expect(referrerCalls(source)).toEqual([ROOT_REG, R]);
      expect(tree.externalReferrers).toEqual(
        new Map([
          ['a', ['c.eth', 'zz.eth']],
          ['b', ['c.eth', 'zz.eth']],
        ]),
      );
    });

    it('treats the canonical name of an alias-reached node as in scope', async () => {
      const source = createFakeNameSource({
        domains: [v2('p', 'p', 'p', null, S), v2('q', 'q', 'q.z', S, R)],
        children: { [S]: ['q'] },
        referrers: { [S]: ['p', 'z'], [R]: ['q.z', 'w'] },
      });

      const tree = await walkTree(source, name('p'), OPTS);

      expect(node(tree, 'q').name).toBe('q.p');
      expect(tree.externalReferrers).toEqual(
        new Map([
          ['p', ['z']],
          ['q', ['w']],
        ]),
      );
    });

    it('skips v1 nodes and records nothing when the capability is unsupported', async () => {
      const v1Source = createFakeNameSource({
        domains: [
          { id: 'r', label: 'r', canonicalName: 'r' },
          { id: 'a', label: 'a' },
        ],
        children: { r: ['a'] },
      });
      const unsupported = createFakeNameSource({
        domains: [v2('r', 'r', 'r', null, R)],
        referrers: null,
      });

      const v1Tree = await walkTree(v1Source, name('r'), OPTS);
      const v2Tree = await walkTree(unsupported, name('r'), OPTS);

      expect(referrerCalls(v1Source)).toEqual([]);
      expect(v1Tree.externalReferrers.size).toBe(0);
      expect(referrerCalls(unsupported)).toEqual([R]);
      expect(v2Tree.externalReferrers.size).toBe(0);
    });
  });
});
