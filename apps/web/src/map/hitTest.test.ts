import { describe, expect, it } from 'vitest';

import { hitTest } from './hitTest.ts';
import type { MapModel, SimNode } from './types.ts';

function model(radii: number[]): MapModel {
  const nodes = radii.map((radius, index): SimNode => ({
    id: `n${index}`,
    index,
    kind: 'subname',
    isRoot: false,
    radius,
    label: `n${index}.eth`,
    shortLabel: `n${index}`,
    stroke: 'none',
    expired: false,
    walletKey: null,
  }));
  return {
    nodes,
    links: [],
    indexById: new Map(nodes.map((n) => [n.id, n.index])),
  };
}

describe('hitTest', () => {
  const m = model([10, 5]);
  const positions = new Float32Array([0, 0, 100, 0]);

  it('returns the circle containing the point', () => {
    expect(hitTest(m, positions, 3, -4)).toBe(0);
    expect(hitTest(m, positions, 102, 2)).toBe(1);
  });

  it('returns null outside every circle', () => {
    expect(hitTest(m, positions, 50, 0)).toBeNull();
    expect(hitTest(m, positions, 0, 11)).toBeNull();
  });

  it('picks the closest centre among overlapping circles', () => {
    const overlapping = model([20, 20]);
    const pos = new Float32Array([0, 0, 30, 0]);
    expect(hitTest(overlapping, pos, 14, 0)).toBe(0);
    expect(hitTest(overlapping, pos, 16, 0)).toBe(1);
  });

  it('ignores nodes that have no position yet', () => {
    expect(hitTest(m, new Float32Array(0), 0, 0)).toBeNull();
  });
});
