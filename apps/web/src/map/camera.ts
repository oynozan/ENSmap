import { FIT_MAX_ZOOM, FIT_PADDING, ZOOM_EXTENT } from './forceConfig.ts';
import type { Transform } from './types.ts';

export function fitTransform(
  positions: Float32Array,
  radii: readonly number[],
  width: number,
  height: number,
): Transform {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; 2 * i + 1 < positions.length; i++) {
    const x = positions[2 * i] ?? 0;
    const y = positions[2 * i + 1] ?? 0;
    const r = radii[i] ?? 0;
    minX = Math.min(minX, x - r);
    minY = Math.min(minY, y - r);
    maxX = Math.max(maxX, x + r);
    maxY = Math.max(maxY, y + r);
  }
  if (minX > maxX || minY > maxY) {
    return { x: width / 2, y: height / 2, k: 1 };
  }

  const fit = Math.min(
    width / (maxX - minX + 2 * FIT_PADDING),
    height / (maxY - minY + 2 * FIT_PADDING),
  );
  const k = Math.max(ZOOM_EXTENT[0], Math.min(FIT_MAX_ZOOM, fit));
  return {
    x: width / 2 - ((minX + maxX) / 2) * k,
    y: height / 2 - ((minY + maxY) / 2) * k,
    k,
  };
}

export function screenToWorld(
  t: Transform,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return { x: (sx - t.x) / t.k, y: (sy - t.y) / t.k };
}
