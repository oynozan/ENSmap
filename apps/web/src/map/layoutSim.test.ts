import { describe, expect, it } from 'vitest';

import { FORCES, RADII } from './forceConfig.ts';
import { createLayoutSim } from './layoutSim.ts';

function star(children: number) {
  const nodes = [
    { radius: RADII.root, isRoot: true },
    ...Array.from({ length: children }, () => ({
      radius: RADII.subname,
      isRoot: false,
    })),
  ];
  const links = Array.from({ length: children }, (_, i) => ({
    source: 0,
    target: i + 1,
  }));
  return { nodes, links };
}

function settle(children: number) {
  const { nodes, links } = star(children);
  const sim = createLayoutSim(nodes, links);
  sim.tick(FORCES.restTicks);
  return { nodes, sim, positions: sim.positions() };
}

function at(positions: Float32Array, i: number) {
  return { x: positions[2 * i] ?? NaN, y: positions[2 * i + 1] ?? NaN };
}

describe('createLayoutSim', () => {
  it('pins the root and keeps 40 subnames from overlapping', () => {
    const { nodes, sim, positions } = settle(40);
    expect(positions).toHaveLength(2 * nodes.length);
    expect(at(positions, 0)).toEqual({ x: 0, y: 0 });
    expect(sim.done()).toBe(true);
    expect(sim.alpha()).toBeLessThan(0.001);

    let worst = -Infinity;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = at(positions, i);
        const b = at(positions, j);
        const gap = Math.hypot(a.x - b.x, a.y - b.y);
        const overlap = (nodes[i]?.radius ?? 0) + (nodes[j]?.radius ?? 0) - gap;
        worst = Math.max(worst, overlap);
      }
    }
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('keeps 12 subnames close to the root', () => {
    const { nodes, positions } = settle(12);
    const limit = FORCES.link.distance + RADII.root + RADII.subname + 20;
    for (let i = 1; i < nodes.length; i++) {
      const { x, y } = at(positions, i);
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(limit);
    }
  });

  it('is deterministic', () => {
    expect(settle(25).positions).toEqual(settle(25).positions);
  });

  it('is not done before it has ticked', () => {
    const { nodes, links } = star(3);
    const sim = createLayoutSim(nodes, links);
    expect(sim.done()).toBe(false);
    expect(sim.alpha()).toBe(1);
  });
});
