import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from 'd3-force';

import { FORCES } from './forceConfig.ts';

interface LayoutNode extends SimulationNodeDatum {
  radius: number;
}

interface LayoutLink {
  source: number | LayoutNode;
  target: number | LayoutNode;
  distance: number;
}

export function createLayoutSim(
  nodes: { radius: number; isRoot: boolean }[],
  links: { source: number; target: number }[],
): {
  tick(n: number): void;
  positions(): Float32Array<ArrayBuffer>;
  alpha(): number;
  done(): boolean;
} {
  const simNodes = nodes.map(({ radius, isRoot }): LayoutNode =>
    isRoot ? { radius, fx: 0, fy: 0 } : { radius },
  );
  // Fresh objects, since forceLink swaps the indices for node references
  const simLinks = links.map(({ source, target }): LayoutLink => ({
    source,
    target,
    distance:
      FORCES.link.distance +
      (nodes[source]?.radius ?? 0) +
      (nodes[target]?.radius ?? 0),
  }));

  const sim = forceSimulation(simNodes)
    .alphaDecay(FORCES.alphaDecay)
    .velocityDecay(FORCES.velocityDecay)
    .force(
      'link',
      forceLink<LayoutNode, LayoutLink>(simLinks)
        .distance((link) => link.distance)
        .strength(FORCES.link.strength),
    )
    .force(
      'charge',
      forceManyBody<LayoutNode>()
        .strength(FORCES.charge.strength)
        .distanceMax(FORCES.charge.distanceMax),
    )
    .force(
      'collide',
      forceCollide<LayoutNode>((node) => node.radius + FORCES.collide.padding)
        .strength(FORCES.collide.strength)
        .iterations(FORCES.collide.iterations),
    )
    .force('x', forceX<LayoutNode>(0).strength(FORCES.position.strength))
    .force('y', forceY<LayoutNode>(0).strength(FORCES.position.strength))
    .stop();

  return {
    tick(n) {
      sim.tick(n);
    },
    positions() {
      const out = new Float32Array(simNodes.length * 2);
      simNodes.forEach((node, i) => {
        out[2 * i] = node.x ?? 0;
        out[2 * i + 1] = node.y ?? 0;
      });
      return out;
    },
    alpha: () => sim.alpha(),
    done: () => sim.alpha() < sim.alphaMin(),
  };
}
