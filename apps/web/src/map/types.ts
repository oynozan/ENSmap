import type { EdgeKind, NodeKind } from '@ensmap/core/schema';

export type Stroke = 'verified' | 'unverified' | 'none';

export interface SimNode {
  id: string;
  index: number;
  kind: NodeKind;
  isRoot: boolean;
  radius: number;
  label: string;
  shortLabel: string;
  stroke: Stroke;
  expired: boolean;
  walletKey: string | null;
}

export interface SimLink {
  source: number;
  target: number;
  kind: EdgeKind;
}

export interface MapModel {
  nodes: SimNode[];
  links: SimLink[];
  indexById: ReadonlyMap<string, number>;
}

export interface Transform {
  x: number;
  y: number;
  k: number;
}

export interface Frame {
  model: MapModel;
  // World x, y interleaved, 2 entries per node
  positions: Float32Array;
  transform: Transform;
  hovered: number | null;
  selected: number | null;
  focused: number | null;
  highlighted: ReadonlySet<number>;
  showAllLabels: boolean;
}

export interface LayoutEngine {
  start(model: MapModel, opts: { reducedMotion: boolean }): void;
  onPositions(cb: (positions: Float32Array, done: boolean) => void): () => void;
  stop(): void;
}

export interface MapRenderer {
  resize(width: number, height: number, dpr: number): void;
  draw(frame: Frame): void;
}
