import type { MapModel } from './types.ts';

// A linear scan is fast enough for the 1,000-name fetch cap
export function hitTest(
  model: MapModel,
  positions: Float32Array,
  wx: number,
  wy: number,
): number | null {
  let hit: number | null = null;
  let best = Infinity;
  for (const node of model.nodes) {
    const x = positions[2 * node.index];
    const y = positions[2 * node.index + 1];
    if (x === undefined || y === undefined) continue;
    const d2 = (wx - x) ** 2 + (wy - y) ** 2;
    if (d2 <= node.radius ** 2 && d2 < best) {
      hit = node.index;
      best = d2;
    }
  }
  return hit;
}
