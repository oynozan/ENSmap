import type { Graph } from '@ensmap/core/schema';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type D3ZoomEvent } from 'd3-zoom';
import { useEffect, useRef, type RefObject } from 'react';

import { fitTransform, screenToWorld } from './camera.ts';
import { createCanvasRenderer } from './canvasRenderer.ts';
import { LABEL_ZOOM, ZOOM_EXTENT } from './forceConfig.ts';
import { hitTest } from './hitTest.ts';
import { buildModel, sameWallet } from './model.ts';
import type { MapModel, Transform } from './types.ts';
import { createWorkerLayout } from './workerLayout.ts';

const LABEL_FONT = "200 12px 'Lexend Deca Variable'";
// Pixels a press may move and still count as a click rather than a pan
const CLICK_DISTANCE = 4;
// Room kept around a revealed bubble for its label
const REVEAL_MARGIN = 24;
const NO_HIGHLIGHT: ReadonlySet<number> = new Set();
const EMPTY_MODEL: MapModel = { nodes: [], links: [], indexById: new Map() };

// Where an element over the map starts, in the map's own coordinates
interface Cover {
  left: number;
  top: number;
}

interface MapController {
  setSelected(id: string | null, cover: Cover | null): void;
  setFocused(id: string | null): void;
  destroy(): void;
}

// Plain DOM and d3 state for one graph; React only mounts and feeds it
function createMapController(
  container: HTMLDivElement,
  canvas: HTMLCanvasElement,
  graph: Graph,
  callbacks: { onSelect(id: string | null): void; onReady(): void },
): MapController {
  const model = buildModel(graph);
  const radii = model.nodes.map((node) => node.radius);
  const renderer = createCanvasRenderer(canvas);
  const layout = createWorkerLayout();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let positions: Float32Array | null = null;
  let transform: Transform = { x: 0, y: 0, k: 1 };
  let size = { width: 0, height: 0 };
  let hovered: number | null = null;
  let highlighted = NO_HIGHLIGHT;
  let selected: number | null = null;
  let focused: number | null = null;
  let fontsReady = false;
  let userMoved = false;
  let settled = false;
  let announced = false;
  let destroyed = false;
  let frameRequest = 0;

  const indexOf = (id: string | null) =>
    id === null ? null : (model.indexById.get(id) ?? null);

  function draw(): void {
    frameRequest = 0;
    if (destroyed || size.width === 0 || size.height === 0) return;
    const ready = positions !== null && fontsReady;
    // Until then an empty frame paints the ground over the opaque canvas
    renderer.draw({
      model: ready ? model : EMPTY_MODEL,
      positions: positions ?? new Float32Array(0),
      transform,
      hovered,
      selected,
      focused,
      highlighted,
      showAllLabels: transform.k >= LABEL_ZOOM,
    });
    if (ready && settled && !announced) {
      announced = true;
      container.dataset.mapReady = 'true';
      callbacks.onReady();
    }
  }

  function invalidate(): void {
    if (frameRequest === 0) frameRequest = requestAnimationFrame(draw);
  }

  const zoomBehavior = zoom<HTMLCanvasElement, unknown>()
    .scaleExtent(ZOOM_EXTENT)
    .clickDistance(CLICK_DISTANCE)
    .on('zoom', (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
      // A drag or wheel gesture outlives destroy() until its mouseup or timeout
      if (destroyed) return;
      const { x, y, k } = event.transform;
      transform = { x, y, k };
      // Programmatic fits have no source event
      if (event.sourceEvent !== null) userMoved = true;
      invalidate();
    });
  const canvasSelection = select(canvas).call(zoomBehavior);

  // Follows the layout until the user takes over the camera
  function fit(): void {
    if (userMoved || size.width === 0) return;
    const t =
      positions === null
        ? { x: size.width / 2, y: size.height / 2, k: 1 }
        : fitTransform(positions, radii, size.width, size.height);
    zoomBehavior.transform(
      canvasSelection,
      zoomIdentity.translate(t.x, t.y).scale(t.k),
    );
  }

  // The larger strip a cover leaves free, left of a side panel or above a bottom sheet
  function visibleArea(cover: Cover | null): { width: number; height: number } {
    if (cover === null) return size;
    const left = {
      width: Math.min(size.width, cover.left),
      height: size.height,
    };
    const above = {
      width: size.width,
      height: Math.min(size.height, cover.top),
    };
    return left.width * left.height >= above.width * above.height
      ? left
      : above;
  }

  // Pans a selection into view, or out from under a cover, at the same zoom
  function reveal(index: number, cover: Cover | null): void {
    const node = model.nodes[index];
    const area = visibleArea(cover);
    if (positions === null || node === undefined) return;
    if (area.width <= 0 || area.height <= 0) return;
    const { x: tx, y: ty, k } = transform;
    const x = tx + (positions[2 * index] ?? 0) * k;
    const y = ty + (positions[2 * index + 1] ?? 0) * k;
    const r = node.radius * k + REVEAL_MARGIN;
    if (
      x - r >= 0 &&
      x + r <= area.width &&
      y - r >= 0 &&
      y + r <= area.height
    ) {
      return;
    }
    // Otherwise the next layout tick would fit the camera back over the cover
    userMoved = true;
    zoomBehavior.transform(
      canvasSelection,
      zoomIdentity
        .translate(tx + area.width / 2 - x, ty + area.height / 2 - y)
        .scale(k),
    );
  }

  const stopListening = layout.onPositions((next, done) => {
    positions = next;
    settled ||= done;
    fit();
    invalidate();
  });

  function resize(): void {
    size = { width: container.clientWidth, height: container.clientHeight };
    renderer.resize(size.width, size.height, devicePixelRatio);
    fit();
    // Resizing clears the canvas, so repaint before this frame is shown
    cancelAnimationFrame(frameRequest);
    draw();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(container);

  // Moving the window to a screen with another pixel ratio resizes nothing
  let pixelRatioQuery: MediaQueryList | null = null;
  function watchPixelRatio(): void {
    pixelRatioQuery?.removeEventListener('change', onPixelRatioChange);
    pixelRatioQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    pixelRatioQuery.addEventListener('change', onPixelRatioChange);
  }
  function onPixelRatioChange(): void {
    watchPixelRatio();
    resize();
  }
  watchPixelRatio();

  function hitAt(event: MouseEvent): number | null {
    if (positions === null) return null;
    const rect = canvas.getBoundingClientRect();
    const world = screenToWorld(
      transform,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    return hitTest(model, positions, world.x, world.y);
  }

  function setHovered(index: number | null): void {
    if (index === hovered) return;
    hovered = index;
    highlighted = index === null ? NO_HIGHLIGHT : sameWallet(model, index);
    canvas.style.cursor = index === null ? '' : 'pointer';
    invalidate();
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerType !== 'touch') setHovered(hitAt(event));
  }

  function onPointerLeave(): void {
    setHovered(null);
  }

  function onClick(event: MouseEvent): void {
    const hit = hitAt(event);
    callbacks.onSelect(hit === null ? null : (model.nodes[hit]?.id ?? null));
  }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('click', onClick);

  void document.fonts
    .load(LABEL_FONT)
    .catch(() => [])
    .then(() => {
      if (destroyed) return;
      fontsReady = true;
      invalidate();
    });

  delete container.dataset.mapReady;
  layout.start(model, { reducedMotion });

  return {
    setSelected(id, cover) {
      selected = indexOf(id);
      if (selected !== null) reveal(selected, cover);
      invalidate();
    },
    setFocused(id) {
      focused = indexOf(id);
      invalidate();
    },
    destroy() {
      destroyed = true;
      stopListening();
      layout.stop();
      observer.disconnect();
      pixelRatioQuery?.removeEventListener('change', onPixelRatioChange);
      cancelAnimationFrame(frameRequest);
      canvasSelection.on('.zoom', null);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('click', onClick);
      canvas.style.cursor = '';
      delete container.dataset.mapReady;
    },
  };
}

export function MapView(props: {
  graph: Graph;
  selectedId: string | null;
  focusedId: string | null;
  onSelect: (id: string | null) => void;
  onReady?: () => void;
  // An element over the map, such as the details panel, that a selection is panned out from under
  coveredBy?: RefObject<HTMLElement | null>;
}) {
  const { graph, selectedId, focusedId, coveredBy } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<MapController | null>(null);
  // The controller outlives renders, so it calls the latest callbacks
  const callbacksRef = useRef(props);
  useEffect(() => {
    callbacksRef.current = props;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    // A canvas per graph, so a gesture still running on the last one cannot reach this one
    const canvas = document.createElement('canvas');
    canvas.className = 'map-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    container.append(canvas);
    const controller = createMapController(container, canvas, graph, {
      onSelect: (id) => {
        callbacksRef.current.onSelect(id);
      },
      onReady: () => {
        callbacksRef.current.onReady?.();
      },
    });
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      canvas.remove();
      controllerRef.current = null;
    };
  }, [graph]);

  useEffect(() => {
    // Offsets rather than a client rect, which the panel's slide-in transform would skew
    const cover = coveredBy?.current;
    controllerRef.current?.setSelected(
      selectedId,
      cover ? { left: cover.offsetLeft, top: cover.offsetTop } : null,
    );
  }, [graph, selectedId, coveredBy]);

  useEffect(() => {
    controllerRef.current?.setFocused(focusedId);
  }, [graph, focusedId]);

  return <div ref={containerRef} className="map-view" />;
}
