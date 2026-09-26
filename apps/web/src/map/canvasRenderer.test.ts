import { describe, expect, it } from 'vitest';

import { COLORS, FONTS } from '../theme.ts';
import { drawFrame } from './canvasRenderer.ts';
import type { Frame, MapModel, SimNode, Stroke } from './types.ts';

interface Call {
  method: string;
  args: unknown[];
  state: Record<string, unknown>;
}

// Records every method call with a snapshot of the properties set so far
function fakeContext() {
  const state: Record<string, unknown> = {};
  const calls: Call[] = [];
  const ctx = new Proxy(state, {
    get(_target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in state) return state[key];
      return (...args: unknown[]) => {
        calls.push({ method: key, args, state: { ...state } });
      };
    },
    set(_target, key, value) {
      if (typeof key === 'string') state[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function simNode(
  index: number,
  stroke: Stroke,
  extra: Partial<SimNode> = {},
): SimNode {
  return {
    id: `n${index}`,
    index,
    kind: 'subname',
    isRoot: false,
    radius: 5,
    label: `n${index}.root.eth`,
    shortLabel: `n${index}`,
    stroke,
    expired: false,
    walletKey: null,
    ...extra,
  };
}

const nodes = [
  simNode(0, 'none', {
    kind: 'name',
    isRoot: true,
    radius: 26,
    label: 'root.eth',
    shortLabel: 'root.eth',
  }),
  simNode(1, 'verified', { walletKey: 'w' }),
  simNode(2, 'unverified', { walletKey: 'w' }),
  simNode(3, 'none', { expired: true }),
];

const model: MapModel = {
  nodes,
  links: [
    { source: 0, target: 1, kind: 'subname' },
    { source: 0, target: 2, kind: 'subname' },
    { source: 0, target: 3, kind: 'subname' },
  ],
  indexById: new Map(nodes.map((n) => [n.id, n.index])),
};

function frame(extra: Partial<Frame> = {}): Frame {
  return {
    model,
    positions: new Float32Array([0, 0, 60, 0, -60, 0, 0, 60]),
    transform: { x: 200, y: 150, k: 1 },
    hovered: null,
    selected: null,
    focused: null,
    highlighted: new Set(),
    showAllLabels: false,
    ...extra,
  };
}

const size = { width: 400, height: 300, dpr: 2 };

function draw(extra: Partial<Frame> = {}) {
  const { ctx, calls } = fakeContext();
  drawFrame(ctx, frame(extra), size);
  return calls;
}

const named = (calls: Call[], method: string) =>
  calls.filter((c) => c.method === method);

describe('drawFrame', () => {
  it('clears to the ground colour at the device pixel ratio', () => {
    const calls = draw();
    expect(calls[0]).toMatchObject({ method: 'setTransform' });
    expect(calls[0]?.args).toEqual([2, 0, 0, 2, 0, 0]);
    const clear = named(calls, 'fillRect')[0];
    expect(clear?.state['fillStyle']).toBe(COLORS.ground);
    expect(clear?.state['globalAlpha']).toBe(1);
    expect(clear?.args).toEqual([0, 0, 400, 300]);
  });

  it('draws edges in the line colour at 60% alpha', () => {
    const strokes = named(draw(), 'stroke');
    expect(strokes[0]?.state).toMatchObject({
      strokeStyle: COLORS.line,
      globalAlpha: 0.6,
      lineWidth: 1,
    });
  });

  it('strokes a verified node in sage', () => {
    const strokes = named(draw(), 'stroke');
    expect(strokes.some((c) => c.state['strokeStyle'] === COLORS.sage)).toBe(
      true,
    );
  });

  it('strokes an unverified node in bone at 40% alpha', () => {
    const strokes = named(draw(), 'stroke');
    expect(
      strokes.some(
        (c) =>
          c.state['strokeStyle'] === COLORS.bone &&
          c.state['globalAlpha'] === 0.4,
      ),
    ).toBe(true);
  });

  it('dashes a node without a wallet', () => {
    const dashes = named(draw(), 'setLineDash').map((c) => c.args[0]);
    expect(dashes).toContainEqual([3, 3]);
  });

  it('fills an expired dot in coral', () => {
    const fills = named(draw(), 'fill');
    expect(fills.some((c) => c.state['fillStyle'] === COLORS.coral)).toBe(true);
  });

  it('labels only the root when zoomed out with nothing hovered', () => {
    const texts = named(draw(), 'fillText');
    expect(texts).toHaveLength(1);
    expect(texts[0]?.args[0]).toBe('root.eth');
    expect(texts[0]?.state).toMatchObject({
      font: `200 12px ${FONTS.display}`,
      fillStyle: COLORS.ash,
      textAlign: 'center',
    });
  });

  it('labels every node when showAllLabels is set', () => {
    const texts = named(draw({ showAllLabels: true }), 'fillText');
    expect(texts.map((c) => c.args[0])).toEqual(['root.eth', 'n1', 'n2', 'n3']);
  });

  it('uses the full label for hovered, selected and focused nodes', () => {
    const texts = named(
      draw({ hovered: 1, selected: 2, focused: 3 }),
      'fillText',
    );
    expect(texts.map((c) => c.args[0]).sort()).toEqual([
      'n1.root.eth',
      'n2.root.eth',
      'n3.root.eth',
      'root.eth',
    ]);
  });

  it('brightens highlighted nodes and thickens the selected stroke', () => {
    const strokes = named(
      draw({ hovered: 1, highlighted: new Set([1, 2]), selected: 2 }),
      'stroke',
    );
    expect(strokes.some((c) => c.state['strokeStyle'] === COLORS.sage)).toBe(
      false,
    );
    expect(
      strokes.some(
        (c) =>
          c.state['strokeStyle'] === COLORS.bone &&
          c.state['globalAlpha'] === 1 &&
          c.state['lineWidth'] === 1.5,
      ),
    ).toBe(true);
  });

  it('draws a focus ring 4 px outside the focused bubble', () => {
    const calls = draw({ focused: 1 });
    const arcs = named(calls, 'arc');
    const ring = arcs.at(-1);
    // Node 1 sits at world (60, 0), so screen (260, 150)
    expect(ring?.args.slice(0, 3)).toEqual([260, 150, 9]);
    expect(named(calls, 'stroke').at(-1)?.state).toMatchObject({
      strokeStyle: COLORS.bone,
      globalAlpha: 1,
      lineWidth: 1,
    });
  });
});
