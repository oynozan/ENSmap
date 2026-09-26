import type { Graph } from '@ensmap/core/schema';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type D3ZoomEvent } from 'd3-zoom';
import { useEffect, useRef } from 'react';

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
const NO_HIGHLIGHT: ReadonlySet<number> = new Set();
const EMPTY_MODEL: MapModel = { nodes: [], links: [], indexById: new Map() };

interface MapController {
  setSelected(id: string | null): void;
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
  let frameRequest = 0;

  const indexOf = (id: string | null) =>
    id === null ? null : (model.indexById.get(id) ?? null);

  function draw(): void {
    frameRequest = 0;
    if (size.width === 0 || size.height === 0) return;
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

  const stopListening = layout.onPositions((next, done) => {
    positions = next;
    settled ||= done;
    fit();
    invalidate();
  });

  const observer = new ResizeObserver(() => {
    size = { width: container.clientWidth, height: container.clientHeight };
    renderer.resize(size.width, size.height, devicePixelRatio);
    fit();
    // Resizing clears the canvas, so repaint before this frame is shown
    cancelAnimationFrame(frameRequest);
    draw();
  });
  observer.observe(container);

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

  let destroyed = false;
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
    setSelected(id) {
      selected = indexOf(id);
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
}) {
  const { graph, selectedId, focusedId } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<MapController | null>(null);
  // The controller outlives renders, so it calls the latest callbacks
  const callbacksRef = useRef(props);
  useEffect(() => {
    callbacksRef.current = props;
  });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (container === null || canvas === null) return;
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
      controllerRef.current = null;
    };
  }, [graph]);

  useEffect(() => {
    controllerRef.current?.setSelected(selectedId);
  }, [graph, selectedId]);

  useEffect(() => {
    controllerRef.current?.setFocused(focusedId);
  }, [graph, focusedId]);

  return (
    <div ref={containerRef} className="map-view">
      <canvas ref={canvasRef} className="map-canvas" aria-hidden="true" />
    </div>
  );
}
