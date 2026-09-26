// @vitest-environment jsdom
import type { Graph, GraphNode } from '@ensmap/core/schema';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MapView } from './MapView.tsx';
import type { Frame } from './types.ts';

type PositionsListener = (positions: Float32Array, done: boolean) => void;

const fakes = vi.hoisted(() => ({
  layouts: [] as { emit: (positions: Float32Array, done: boolean) => void }[],
  renderers: [] as {
    resize: ReturnType<typeof vi.fn>;
    draw: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock('./workerLayout.ts', () => ({
  createWorkerLayout: () => {
    const listeners = new Set<PositionsListener>();
    fakes.layouts.push({
      emit: (positions, done) => {
        for (const listener of listeners) listener(positions, done);
      },
    });
    return {
      start: () => undefined,
      stop: () => undefined,
      onPositions: (cb: PositionsListener) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    };
  },
}));

vi.mock('./canvasRenderer.ts', () => ({
  createCanvasRenderer: () => {
    const renderer = { resize: vi.fn(), draw: vi.fn() };
    fakes.renderers.push(renderer);
    return renderer;
  },
}));

// Vitest's global window is not a jsdom Window, which MouseEvent requires as its view
const domWindow = (globalThis as unknown as { jsdom: { window: Window } }).jsdom
  .window;

const WIDTH = 800;
const HEIGHT = 600;

let observers: (() => void)[] = [];
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let mediaQueries: { media: string; listeners: Set<() => void> }[] = [];

function flushFrames() {
  const pending = [...frames.values()];
  frames = new Map();
  for (const callback of pending) callback(performance.now());
}

function setPixelRatio(ratio: number) {
  Object.defineProperty(window, 'devicePixelRatio', {
    value: ratio,
    configurable: true,
  });
}

beforeEach(() => {
  observers = [];
  frames = new Map();
  mediaQueries = [];
  fakes.layouts.length = 0;
  fakes.renderers.length = 0;
  setPixelRatio(1);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(WIDTH);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(
    HEIGHT,
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', (media: string) => {
    const query = { media, listeners: new Set<() => void>() };
    mediaQueries.push(query);
    return {
      media,
      matches: false,
      addEventListener: (_type: string, listener: () => void) => {
        query.listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        query.listeners.delete(listener);
      },
    };
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  Object.defineProperty(document, 'fonts', {
    value: { load: () => Promise.resolve([]) },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function node(id: string, label: string): GraphNode {
  return {
    id,
    kind: id === 'root' ? 'name' : 'subname',
    label,
    tags: [],
    size: { metric: 'subnamesHeld', value: 0 },
  };
}

function graphFor(name: string): Graph {
  const nodes = [node('root', name), node('child', `c.${name}`)];
  return {
    version: 1,
    nodes,
    edges: [
      {
        id: 'subname:root:child',
        source: 'root',
        target: 'child',
        kind: 'subname',
        directed: true,
      },
    ],
    meta: {
      namespace: 'sepolia-v2',
      root: 'root',
      computedAt: '2026-09-26T00:00:00.000Z',
      caps: { fetch: 1000 },
      filters: {},
      totals: {
        names: nodes.length,
        indexed: { value: nodes.length, exact: true },
        wallets: 0,
      },
      truncated: [],
      warnings: [],
    },
  };
}

function lastFrame(renderer: { draw: ReturnType<typeof vi.fn> } | undefined) {
  return renderer?.draw.mock.calls.at(-1)?.[0] as Frame | undefined;
}

function view(
  graph: Graph,
  extra: {
    selectedId?: string;
    coveredBy?: RefObject<HTMLElement | null>;
  } = {},
) {
  return (
    <MapView
      graph={graph}
      selectedId={extra.selectedId ?? null}
      focusedId={null}
      onSelect={() => undefined}
      coveredBy={extra.coveredBy}
    />
  );
}

// A bottom sheet over the lower half of the map, as on a phone
function bottomSheet(): RefObject<HTMLElement | null> {
  const sheet = document.createElement('aside');
  Object.defineProperty(sheet, 'offsetLeft', { value: 0 });
  Object.defineProperty(sheet, 'offsetTop', { value: HEIGHT / 2 });
  return { current: sheet };
}

// Screen position of the child, which the layout puts 200 px below the root
function childOnScreen(frame: Frame | undefined) {
  const t = frame?.transform ?? { x: 0, y: 0, k: 1 };
  return { x: t.x, y: t.y + 200 * t.k, r: 5 * t.k };
}

describe('MapView', () => {
  it('keeps a gesture on the old map away from the next map', () => {
    const { container, rerender } = render(view(graphFor('a.eth')));
    const [resizeA] = observers;
    act(() => {
      resizeA?.();
    });
    const canvasA = container.querySelector('canvas');
    expect(canvasA).not.toBeNull();

    // A drag on the first map is still running when the next graph lands
    fireEvent.mouseDown(canvasA as HTMLCanvasElement, {
      view: domWindow,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.mouseMove(domWindow, {
      view: domWindow,
      clientX: 140,
      clientY: 120,
    });
    rerender(view(graphFor('b.eth')));
    const drawsA = fakes.renderers[0]?.draw.mock.calls.length;

    act(() => {
      observers[1]?.();
    });
    expect(lastFrame(fakes.renderers[1])?.transform).toEqual({
      x: WIDTH / 2,
      y: HEIGHT / 2,
      k: 1,
    });

    fireEvent.mouseMove(domWindow, {
      view: domWindow,
      clientX: 180,
      clientY: 140,
    });
    act(() => {
      flushFrames();
    });
    expect(fakes.renderers[0]?.draw.mock.calls.length).toBe(drawsA);
    fireEvent.mouseUp(domWindow, { view: domWindow });
  });

  it('resizes the backing store when the pixel ratio changes', () => {
    render(view(graphFor('a.eth')));
    act(() => {
      observers[0]?.();
    });
    const renderer = fakes.renderers[0];
    expect(renderer?.resize).toHaveBeenLastCalledWith(WIDTH, HEIGHT, 1);
    const draws = renderer?.draw.mock.calls.length ?? 0;

    setPixelRatio(2);
    const query = mediaQueries.find((q) => q.media.includes('dppx'));
    expect(query?.media).toBe('(resolution: 1dppx)');
    act(() => {
      for (const listener of query?.listeners ?? []) listener();
    });

    expect(renderer?.resize).toHaveBeenLastCalledWith(WIDTH, HEIGHT, 2);
    expect(renderer?.draw.mock.calls.length).toBeGreaterThan(draws);
    expect(query?.listeners.size).toBe(0);
    expect(
      mediaQueries.find((q) => q.media === '(resolution: 2dppx)')?.listeners
        .size,
    ).toBe(1);
  });

  it('pans a selected bubble out from under the panel', () => {
    const graph = graphFor('a.eth');
    const coveredBy = bottomSheet();
    const { rerender } = render(view(graph, { coveredBy }));
    act(() => {
      observers[0]?.();
      fakes.layouts[0]?.emit(new Float32Array([0, 0, 0, 200]), true);
      flushFrames();
    });
    const renderer = fakes.renderers[0];
    const scale = lastFrame(renderer)?.transform.k;
    const before = childOnScreen(lastFrame(renderer));
    expect(before.y).toBeGreaterThan(HEIGHT / 2);

    rerender(view(graph, { coveredBy, selectedId: 'child' }));
    act(() => {
      flushFrames();
    });

    const after = childOnScreen(lastFrame(renderer));
    expect(after.y + after.r).toBeLessThan(HEIGHT / 2);
    expect(after.x).toBe(before.x);
    expect(lastFrame(renderer)?.transform.k).toBe(scale);
  });

  it('leaves the camera alone for a selection already in view', () => {
    const graph = graphFor('a.eth');
    const coveredBy = bottomSheet();
    const { rerender } = render(view(graph, { coveredBy }));
    act(() => {
      observers[0]?.();
      fakes.layouts[0]?.emit(new Float32Array([0, 0, 0, 200]), true);
      flushFrames();
    });
    const before = lastFrame(fakes.renderers[0])?.transform;

    rerender(view(graph, { coveredBy, selectedId: 'root' }));
    act(() => {
      flushFrames();
    });

    expect(lastFrame(fakes.renderers[0])?.transform).toEqual(before);
  });
});
