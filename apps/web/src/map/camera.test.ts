import { describe, expect, it } from 'vitest';

import { fitTransform, screenToWorld } from './camera.ts';
import { FIT_MAX_ZOOM, ZOOM_EXTENT } from './forceConfig.ts';

describe('fitTransform', () => {
  it('centres a single bubble at the maximum fit zoom', () => {
    const t = fitTransform(new Float32Array([0, 0]), [26], 800, 600);
    expect(t).toEqual({ x: 400, y: 300, k: FIT_MAX_ZOOM });
    expect(t.k).toBe(2);
  });

  it('zooms out to fit a wide layout', () => {
    const t = fitTransform(
      new Float32Array([-500, 0, 500, 0]),
      [10, 10],
      800,
      600,
    );
    expect(t.k).toBeLessThan(1);
    expect(t.x).toBeCloseTo(400);
    expect(t.y).toBeCloseTo(300);
  });

  it('centres an off-origin layout', () => {
    const t = fitTransform(
      new Float32Array([100, 50, 300, 50]),
      [5, 5],
      800,
      600,
    );
    const centre = screenToWorld(t, 400, 300);
    expect(centre.x).toBeCloseTo(200);
    expect(centre.y).toBeCloseTo(50);
  });

  it('never zooms below the zoom extent', () => {
    expect(fitTransform(new Float32Array([0, 0]), [26], 0, 0).k).toBe(
      ZOOM_EXTENT[0],
    );
  });
});

describe('screenToWorld', () => {
  it('inverts the transform', () => {
    const t = { x: 120, y: -40, k: 1.5 };
    const world = { x: 33, y: -7 };
    const screen = { x: t.x + world.x * t.k, y: t.y + world.y * t.k };
    const back = screenToWorld(t, screen.x, screen.y);
    expect(back.x).toBeCloseTo(world.x);
    expect(back.y).toBeCloseTo(world.y);
  });
});
