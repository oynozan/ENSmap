import { describe, expect, it } from 'vitest';

import { parseNameInput, type InterpretedName } from '../ens/names.ts';
import {
  bindingStart,
  deriveBindings,
  nameMatches,
  type Binding,
  type DeriveBindingsInput,
} from './bindings.ts';
import type {
  Address,
  DomainRecord,
  NameTree,
  RecordEvent,
  RecordHistory,
  TreeNode,
} from './types.ts';

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
const X = addr('bb');
const O = addr('cc');
const R = addr('11');
const R2 = addr('22');

const REGISTERED = new Date('2020-01-01T00:00:00.000Z');
const SET_AT = new Date('2023-05-01T00:00:00.000Z');
const EVENT_AT = new Date('2024-02-03T04:05:06.000Z');

/* Event builders */

function resolverSet(
  block: number,
  logIndex: number,
  resolver: Address | null,
): RecordEvent {
  return {
    kind: 'resolver-set',
    resolver,
    block: BigInt(block),
    logIndex,
    timestamp: null,
  };
}

function addrSet(
  block: number,
  logIndex: number,
  resolver: Address,
  record: string,
  address: Address | null,
  timestamp: Date | null = null,
): RecordEvent {
  return {
    kind: 'addr-set',
    resolver,
    record,
    address,
    block: BigInt(block),
    logIndex,
    timestamp,
  };
}

function linked(
  block: number,
  logIndex: number,
  resolver: Address,
  record: string,
  timestamp: Date | null = null,
): RecordEvent {
  return {
    kind: 'record-linked',
    resolver,
    record,
    block: BigInt(block),
    logIndex,
    timestamp,
  };
}

function cleared(
  block: number,
  logIndex: number,
  resolver: Address,
  record: string,
): RecordEvent {
  return {
    kind: 'records-cleared',
    resolver,
    record,
    block: BigInt(block),
    logIndex,
    timestamp: null,
  };
}

function at(block: number, logIndex: number, timestamp: Date | null = null) {
  return { block: BigInt(block), logIndex, timestamp };
}

/* Tree builders */

function domain(id: string, overrides: Partial<DomainRecord> = {}) {
  const record: DomainRecord = {
    id,
    label: id,
    canonicalName: null,
    protocol: 'v1',
    registry: null,
    subregistry: null,
    owner: null,
    indexedResolver: null,
    indexedEthAddress: null,
    registeredAt: null,
    expiresAt: null,
    expired: false,
  };
  return { ...record, ...overrides };
}

function treeNode(
  id: string,
  rawName: string,
  overrides: { record?: Partial<DomainRecord>; aliasNames?: string[] } = {},
): TreeNode {
  const nodeName = name(rawName);
  return {
    record: domain(id, overrides.record),
    name: nodeName,
    aliasNames: (overrides.aliasNames ?? []).map(name),
    parentIds: [],
    level: nodeName.split('.').length - 2,
  };
}

function treeOf(...nodes: TreeNode[]): NameTree {
  return {
    rootId: nodes[0]?.record.id ?? '',
    nodes: new Map(nodes.map((node) => [node.record.id, node])),
    truncated: false,
    indexedTotal: { value: nodes.length, exact: true },
    externalReferrers: new Map(),
  };
}

// a.r.eth, registered at REGISTERED, owned by O, resolves to W via its own R
function boundNode(
  overrides: { record?: Partial<DomainRecord>; aliasNames?: string[] } = {},
): TreeNode {
  return treeNode('a', 'a.r.eth', {
    ...overrides,
    record: {
      owner: O,
      indexedResolver: R,
      registeredAt: REGISTERED,
      ...overrides.record,
    },
  });
}

function derive(
  overrides: Partial<DeriveBindingsInput> & { tree: NameTree },
): Binding[] {
  return deriveBindings({
    chainId: 1,
    source: 'ens-subgraph',
    resolutions: new Map([[name('a.r.eth'), { address: W, resolver: R }]]),
    primaryNames: new Map(),
    history: null,
    blockTimes: new Map(),
    ...overrides,
  });
}

function only(bindings: Binding[]): Binding {
  expect(bindings).toHaveLength(1);
  const [binding] = bindings;
  if (binding === undefined) {
    throw new Error('no binding');
  }
  return binding;
}

function historyOf(entry: RecordHistory): Map<string, RecordHistory> {
  return new Map([['a', entry]]);
}

describe('bindingStart', () => {
  it('starts at the addr-set that follows the resolver-set', () => {
    const events = [resolverSet(10, 0, R), addrSet(12, 3, R, 'self', W)];
    expect(bindingStart(events, W, R)).toEqual(at(12, 3));
  });

  it('starts at the resolver-set when records were set on the resolver before it was chosen', () => {
    const events = [addrSet(10, 0, R, 'self', W), resolverSet(12, 3, R)];
    expect(bindingStart(events, W, null)).toEqual(at(12, 3));
  });

  it('ignores the seed when the history has a resolver-set', () => {
    const events = [addrSet(1, 0, R, 'self', W), resolverSet(2, 0, R)];
    expect(bindingStart(events, W, R)).toEqual(at(2, 0));
  });

  it('returns the last time the value became the wallet', () => {
    const events = [
      resolverSet(1, 0, R),
      addrSet(2, 0, R, 'self', W),
      addrSet(3, 0, R, 'self', X),
      addrSet(4, 0, R, 'self', W),
    ];
    expect(bindingStart(events, W, R)).toEqual(at(4, 0));
  });

  it('restarts after the records are cleared', () => {
    const events = [
      resolverSet(1, 0, R),
      addrSet(2, 0, R, 'self', W),
      cleared(3, 0, R, 'self'),
      addrSet(4, 0, R, 'self', W),
    ];
    expect(bindingStart(events, W, R)).toEqual(at(4, 0));
  });

  it('returns null when the final value is a different address', () => {
    const events = [
      resolverSet(1, 0, R),
      addrSet(2, 0, R, 'self', W),
      addrSet(3, 0, R, 'self', X),
    ];
    expect(bindingStart(events, W, R)).toBeNull();
  });

  it('returns null when the records end cleared', () => {
    const events = [
      resolverSet(1, 0, R),
      addrSet(2, 0, R, 'self', W),
      cleared(3, 0, R, 'self'),
    ];
    expect(bindingStart(events, W, R)).toBeNull();
  });

  it('returns null when the resolver moves away or is removed', () => {
    const base = [resolverSet(1, 0, R), addrSet(2, 0, R, 'self', W)];
    expect(bindingStart([...base, resolverSet(3, 0, R2)], W, R2)).toBeNull();
    expect(
      bindingStart([...base, resolverSet(3, 0, null)], W, null),
    ).toBeNull();
  });

  it('uses the seed resolver when the history has no resolver-set', () => {
    const events = [addrSet(5, 7, R, 'self', W)];
    expect(bindingStart(events, W, R)).toEqual(at(5, 7));
  });

  it('returns null without a resolver-set or a seed', () => {
    expect(bindingStart([addrSet(5, 7, R, 'self', W)], W, null)).toBeNull();
  });

  it('counts paired identical addr-set events as one change at the first', () => {
    const events = [
      resolverSet(100, 1, R),
      addrSet(200, 297, R, 'self', W),
      addrSet(200, 298, R, 'self', W),
    ];
    expect(bindingStart(events, W, R)).toEqual(at(200, 297));
  });

  it('keeps the earlier start when a later addr-set repeats the wallet', () => {
    const events = [
      resolverSet(1, 0, R),
      addrSet(2, 0, R, 'self', W),
      addrSet(9, 0, R, 'self', W),
    ];
    expect(bindingStart(events, W, R)).toEqual(at(2, 0));
  });

  it('sorts events by block, then log index', () => {
    const byBlock = [
      addrSet(3, 0, R, 'self', W),
      addrSet(2, 0, R, 'self', X),
      resolverSet(1, 0, R),
    ];
    expect(bindingStart(byBlock, W, R)).toEqual(at(3, 0));

    const byLogIndex = [
      addrSet(5, 9, R, 'self', W),
      addrSet(5, 2, R, 'self', X),
      resolverSet(4, 0, R),
    ];
    expect(bindingStart(byLogIndex, W, R)).toEqual(at(5, 9));
  });

  it('compares addresses case-insensitively', () => {
    const checksummed: Address = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
    const lower: Address = '0xabcdef0123456789abcdef0123456789abcdef01';
    const events = [resolverSet(1, 0, R), addrSet(2, 0, R, 'self', lower)];
    expect(bindingStart(events, checksummed, R)).toEqual(at(2, 0));
  });

  describe('v2 record links', () => {
    it('starts at the later of the link and the addr-set', () => {
      expect(
        bindingStart(
          [linked(1, 0, R, '5', EVENT_AT), addrSet(2, 0, R, '5', W, SET_AT)],
          W,
          R,
        ),
      ).toEqual(at(2, 0, SET_AT));
      expect(
        bindingStart(
          [addrSet(1, 0, R, '5', W, SET_AT), linked(2, 0, R, '5', EVENT_AT)],
          W,
          R,
        ),
      ).toEqual(at(2, 0, EVENT_AT));
    });

    it('ignores addr-sets on a record the node is not linked to', () => {
      const events = [
        linked(1, 0, R, '5'),
        addrSet(2, 0, R, '5', X),
        addrSet(3, 0, R, '7', W),
      ];
      expect(bindingStart(events, W, R)).toBeNull();
      expect(bindingStart(events, X, R)).toEqual(at(2, 0));
    });

    it('switches value when the link moves to another record', () => {
      const events = [
        linked(1, 0, R, '5'),
        addrSet(2, 0, R, '5', X),
        addrSet(3, 0, R, '7', W),
        linked(4, 0, R, '7'),
      ];
      expect(bindingStart(events, W, R)).toEqual(at(4, 0));
    });

    it('ignores a link on a resolver that is not active', () => {
      const events = [
        resolverSet(1, 0, R),
        linked(2, 0, R, '5'),
        addrSet(3, 0, R, '5', W),
        linked(4, 0, R2, '5'),
      ];
      expect(bindingStart(events, W, null)).toEqual(at(3, 0));
    });

    it('has no value before the record is linked', () => {
      expect(bindingStart([addrSet(1, 0, R, '5', W)], W, R)).toBeNull();
    });
  });
});

describe('nameMatches', () => {
  const node = treeNode('x', 'x.a.r.eth', {
    aliasNames: ['x.b.r.eth'],
    record: { canonicalName: name('x.c.r.eth') },
  });

  it('matches the in-scope name, an alias and the canonical name', () => {
    expect(nameMatches(node, name('x.a.r.eth'))).toBe(true);
    expect(nameMatches(node, name('x.b.r.eth'))).toBe(true);
    expect(nameMatches(node, name('x.c.r.eth'))).toBe(true);
  });

  it('rejects any other name', () => {
    expect(nameMatches(node, name('x.d.r.eth'))).toBe(false);
    expect(nameMatches(treeNode('y', 'y.r.eth'), name('x.a.r.eth'))).toBe(
      false,
    );
  });
});

describe('deriveBindings', () => {
  it('binds a node to the wallet and resolver of its in-scope name', () => {
    const binding = only(derive({ tree: treeOf(boundNode()) }));
    expect(binding).toEqual({
      nameId: 'a',
      name: name('a.r.eth'),
      chainId: 1,
      address: W,
      resolver: R,
      verified: false,
      verifiedBy: null,
      validFrom: REGISTERED,
      validTo: null,
      windowSource: 'registration',
      source: 'ens-subgraph',
    } satisfies Binding);
  });

  it('skips nodes without an address or without a resolution', () => {
    const tree = treeOf(
      treeNode('root', 'r.eth'),
      boundNode(),
      treeNode('b', 'b.r.eth'),
    );
    const bindings = derive({
      tree,
      resolutions: new Map([
        [name('r.eth'), { address: null, resolver: R }],
        [name('a.r.eth'), { address: W, resolver: R }],
      ]),
    });
    expect(bindings.map((binding) => binding.nameId)).toEqual(['a']);
  });

  it('resolves the in-scope path, not the canonical name', () => {
    const node = treeNode('a', 'a.r.eth', {
      record: { canonicalName: name('a.s.eth') },
    });
    const byCanonical = new Map([
      [name('a.s.eth'), { address: W, resolver: R }],
    ]);
    expect(derive({ tree: treeOf(node), resolutions: byCanonical })).toEqual(
      [],
    );
  });

  it.each([
    ['another resolver', R2, []],
    ['no indexed resolver', null, []],
    ['its own resolver in another casing', R, ['a']],
  ] as const)(
    'binds an alias path answered through %s only when it is its own',
    (_, indexedResolver, expected) => {
      const node = boundNode({
        record: { canonicalName: name('a.s.eth'), indexedResolver },
      });
      const bindings = derive({
        tree: treeOf(node),
        resolutions: new Map([
          [
            name('a.r.eth'),
            { address: W, resolver: R.toUpperCase() as Address },
          ],
        ]),
      });
      expect(bindings.map((binding) => binding.nameId)).toEqual(expected);
    },
  );

  it('keeps tree order and lowercases the wallet and resolver', () => {
    const tree = treeOf(treeNode('root', 'r.eth'), boundNode());
    const bindings = derive({
      tree,
      resolutions: new Map([
        [
          name('r.eth'),
          {
            address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            resolver: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          },
        ],
        [name('a.r.eth'), { address: X, resolver: null }],
      ]),
    });
    expect(
      bindings.map(({ nameId, address, resolver }) => ({
        nameId,
        address,
        resolver,
      })),
    ).toEqual([
      { nameId: 'root', address: W, resolver: addr('bb') },
      { nameId: 'a', address: X, resolver: null },
    ]);
  });

  describe('verified', () => {
    const unowned = { record: { owner: X } };

    it.each([
      ['the in-scope name', 'a.r.eth'],
      ['an alias', 'a.q.eth'],
      ['the canonical name', 'a.s.eth'],
    ])('is verified by primary name when it equals %s', (_, primary) => {
      const node = boundNode({
        aliasNames: ['a.q.eth'],
        record: { owner: X, canonicalName: name('a.s.eth') },
      });
      const binding = only(
        derive({
          tree: treeOf(node),
          primaryNames: new Map([[W, name(primary)]]),
        }),
      );
      expect(binding.verified).toBe(true);
      expect(binding.verifiedBy).toBe('primary-name');
    });

    it('is verified by owner when a checksummed owner equals the wallet', () => {
      const checksummed: Address = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
      const wallet: Address = '0xabcdef0123456789abcdef0123456789abcdef01';
      const binding = only(
        derive({
          tree: treeOf(boundNode({ record: { owner: checksummed } })),
          resolutions: new Map([
            [name('a.r.eth'), { address: wallet, resolver: R }],
          ]),
        }),
      );
      expect(binding.verified).toBe(true);
      expect(binding.verifiedBy).toBe('owner');
    });

    it('prefers primary name when both rules match', () => {
      const binding = only(
        derive({
          tree: treeOf(boundNode()),
          primaryNames: new Map([[W, name('a.r.eth')]]),
        }),
      );
      expect(binding.verifiedBy).toBe('primary-name');
    });

    it('finds the primary name under a checksummed wallet key', () => {
      const binding = only(
        derive({
          tree: treeOf(boundNode(unowned)),
          primaryNames: new Map([
            ['0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', name('a.r.eth')],
          ]),
        }),
      );
      expect(binding.verifiedBy).toBe('primary-name');
    });

    it('is unverified when neither rule matches', () => {
      for (const primaryNames of [
        new Map<Address, InterpretedName | null>(),
        new Map([[W, null]]),
        new Map([[W, name('other.eth')]]),
      ]) {
        const binding = only(
          derive({ tree: treeOf(boundNode(unowned)), primaryNames }),
        );
        expect(binding.verified).toBe(false);
        expect(binding.verifiedBy).toBeNull();
      }
    });

    it('is unverified when the node has no owner', () => {
      const binding = only(
        derive({ tree: treeOf(boundNode({ record: { owner: null } })) }),
      );
      expect(binding.verifiedBy).toBeNull();
    });
  });

  describe('validity window', () => {
    const v1History = [resolverSet(10, 0, R), addrSet(12, 3, R, 'self', W)];

    function window(binding: Binding) {
      return {
        validFrom: binding.validFrom,
        validTo: binding.validTo,
        windowSource: binding.windowSource,
      };
    }

    it('comes from record history when the start block time is known', () => {
      const binding = only(
        derive({
          tree: treeOf(boundNode()),
          history: historyOf({ events: v1History, complete: true }),
          blockTimes: new Map([[12n, SET_AT]]),
        }),
      );
      expect(window(binding)).toEqual({
        validFrom: SET_AT,
        validTo: null,
        windowSource: 'record-history',
      });
    });

    it('prefers the event timestamp over block times', () => {
      const events = [
        linked(10, 0, R, '5', SET_AT),
        addrSet(12, 3, R, '5', W, EVENT_AT),
      ];
      for (const blockTimes of [new Map(), new Map([[12n, SET_AT]])]) {
        const binding = only(
          derive({
            tree: treeOf(boundNode()),
            history: historyOf({ events, complete: true }),
            blockTimes,
          }),
        );
        expect(window(binding)).toEqual({
          validFrom: EVENT_AT,
          validTo: null,
          windowSource: 'record-history',
        });
      }
    });

    it('seeds the history walk with the effective resolver', () => {
      const history = historyOf({
        events: [addrSet(12, 3, R, 'self', W)],
        complete: true,
      });
      const blockTimes = new Map([[12n, SET_AT]]);
      const tree = treeOf(boundNode());
      const viaR = only(derive({ tree, history, blockTimes }));
      expect(viaR.windowSource).toBe('record-history');

      const viaR2 = only(
        derive({
          tree,
          history,
          blockTimes,
          resolutions: new Map([
            [name('a.r.eth'), { address: W, resolver: R2 }],
          ]),
        }),
      );
      expect(viaR2.resolver).toBe(R2);
      expect(window(viaR2)).toEqual({
        validFrom: REGISTERED,
        validTo: null,
        windowSource: 'registration',
      });
    });

    it.each<[string, Map<string, RecordHistory> | null, Map<bigint, Date>]>([
      [
        'the history ends on a different wallet',
        historyOf({
          events: [...v1History, addrSet(13, 0, R, 'self', X)],
          complete: true,
        }),
        new Map([[12n, SET_AT]]),
      ],
      [
        'the history has no events',
        historyOf({ events: [], complete: true }),
        new Map([[12n, SET_AT]]),
      ],
      [
        'the history is incomplete',
        historyOf({ events: v1History, complete: false }),
        new Map([[12n, SET_AT]]),
      ],
      [
        'the start block time is missing',
        historyOf({ events: v1History, complete: true }),
        new Map([[10n, SET_AT]]),
      ],
      [
        'the history has no entry for the node',
        new Map([['other', { events: v1History, complete: true }]]),
        new Map([[12n, SET_AT]]),
      ],
      ['the source has no history', null, new Map([[12n, SET_AT]])],
    ])('falls back to the registration when %s', (_, history, blockTimes) => {
      const binding = only(
        derive({ tree: treeOf(boundNode()), history, blockTimes }),
      );
      expect(window(binding)).toEqual({
        validFrom: REGISTERED,
        validTo: null,
        windowSource: 'registration',
      });
    });

    it('is unknown without history or a registration date', () => {
      const tree = treeOf(boundNode({ record: { registeredAt: null } }));
      for (const history of [
        null,
        historyOf({ events: v1History, complete: false }),
      ]) {
        const binding = only(derive({ tree, history }));
        expect(window(binding)).toEqual({
          validFrom: null,
          validTo: null,
          windowSource: 'unknown',
        });
      }
    });
  });
});
