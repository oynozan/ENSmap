import { describe, expect, it } from 'vitest';

import { CallCounter } from './counter.ts';

describe('CallCounter', () => {
  it('counts calls per provider', () => {
    const counter = new CallCounter();

    counter.inc('rpc');
    counter.inc('ens-subgraph');
    counter.inc('rpc');

    expect(counter.snapshot()).toEqual({ 'ens-subgraph': 1, rpc: 2 });
  });

  it('returns a snapshot that later calls do not change', () => {
    const counter = new CallCounter();
    counter.inc('rpc');

    const before = counter.snapshot();
    counter.inc('rpc');

    expect(before).toEqual({ rpc: 1 });
  });

  it('formats counts sorted by provider', () => {
    const counter = new CallCounter();
    counter.inc('rpc');
    counter.inc('ens-subgraph');
    counter.inc('rpc');

    expect(counter.format()).toBe('API calls: ens-subgraph=1, rpc=2');
  });

  it('formats an empty counter', () => {
    expect(new CallCounter().format()).toBe('API calls: none');
  });
});
