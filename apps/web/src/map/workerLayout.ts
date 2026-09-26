import type { LayoutRequest, LayoutResponse } from './layout.worker.ts';
import type { LayoutEngine } from './types.ts';

type Listener = (positions: Float32Array, done: boolean) => void;

export function createWorkerLayout(): LayoutEngine {
  const listeners = new Set<Listener>();
  let worker: Worker | null = null;

  function stop(): void {
    worker?.terminate();
    worker = null;
  }

  return {
    start(model, { reducedMotion }) {
      stop();
      // One worker per run, so a late message from an older run cannot arrive
      const current = new Worker(
        new URL('./layout.worker.ts', import.meta.url),
        { type: 'module' },
      );
      worker = current;
      current.onmessage = ({ data }: MessageEvent<LayoutResponse>) => {
        if (worker !== current) return;
        for (const listener of listeners) listener(data.positions, data.done);
        if (data.done) stop();
      };
      const request: LayoutRequest = {
        type: 'start',
        nodes: model.nodes.map(({ radius, isRoot }) => ({ radius, isRoot })),
        links: model.links.map(({ source, target }) => ({ source, target })),
        reducedMotion,
      };
      current.postMessage(request);
    },
    onPositions(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    stop,
  };
}
