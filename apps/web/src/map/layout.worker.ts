import { FORCES } from './forceConfig.ts';
import { createLayoutSim } from './layoutSim.ts';

export type LayoutRequest =
  | {
      type: 'start';
      nodes: { radius: number; isRoot: boolean }[];
      links: { source: number; target: number }[];
      reducedMotion: boolean;
    }
  | { type: 'stop' };

export interface LayoutResponse {
  type: 'positions';
  positions: Float32Array;
  done: boolean;
}

// The dom lib types self as Window, and the webworker lib clashes with dom
interface WorkerScope {
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
  postMessage(message: LayoutResponse, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const FRAME_MS = 16;
let timer: ReturnType<typeof setTimeout> | undefined;

function post(positions: Float32Array<ArrayBuffer>, done: boolean): void {
  scope.postMessage({ type: 'positions', positions, done }, [positions.buffer]);
}

scope.onmessage = ({ data }) => {
  clearTimeout(timer);
  timer = undefined;
  if (data.type === 'stop') return;

  const sim = createLayoutSim(data.nodes, data.links);
  if (data.reducedMotion) {
    sim.tick(FORCES.restTicks);
    post(sim.positions(), true);
    return;
  }

  const step = () => {
    sim.tick(FORCES.ticksPerFrame);
    const done = sim.done();
    post(sim.positions(), done);
    timer = done ? undefined : setTimeout(step, FRAME_MS);
  };
  step();
};
