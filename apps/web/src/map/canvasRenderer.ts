import { COLORS, FONTS } from '../theme.ts';
import type { Frame, MapRenderer, SimNode } from './types.ts';

const EDGE_ALPHA = 0.6;
const FILL_ALPHA = 0.04;
const UNVERIFIED_ALPHA = 0.4;
const DASH = [3, 3];
const NO_DASH: number[] = [];
const SELECTED_WIDTH = 1.5;
const EXPIRED_DOT_RADIUS = 2;
const LABEL_FONT = `200 12px ${FONTS.display}`;
const LABEL_GAP = 4;
const FOCUS_GAP = 4;
const TAU = Math.PI * 2;
const DIAGONAL = Math.SQRT1_2;

function strokeColor(node: SimNode, emphasized: boolean) {
  if (emphasized) return { color: COLORS.bone, alpha: 1 };
  if (node.stroke === 'verified') return { color: COLORS.sage, alpha: 1 };
  if (node.stroke === 'unverified') {
    return { color: COLORS.bone, alpha: UNVERIFIED_ALPHA };
  }
  return { color: COLORS.bone, alpha: 1 };
}

// Projects by hand so strokes and labels keep a fixed size at any zoom
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  size: { width: number; height: number; dpr: number },
): void {
  const { model, positions, transform: t } = frame;
  const placed = Math.min(model.nodes.length, Math.floor(positions.length / 2));
  const sx = (i: number) => t.x + (positions[2 * i] ?? 0) * t.k;
  const sy = (i: number) => t.y + (positions[2 * i + 1] ?? 0) * t.k;
  const sr = (node: SimNode) => node.radius * t.k;

  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS.ground;
  ctx.fillRect(0, 0, size.width, size.height);

  /* Edges */
  ctx.globalAlpha = EDGE_ALPHA;
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 1;
  ctx.setLineDash(NO_DASH);
  ctx.beginPath();
  for (const link of model.links) {
    const source = model.nodes[link.source];
    const target = model.nodes[link.target];
    if (!source || !target || link.source >= placed || link.target >= placed) {
      continue;
    }
    const x1 = sx(link.source);
    const y1 = sy(link.source);
    const dx = sx(link.target) - x1;
    const dy = sy(link.target) - y1;
    const length = Math.hypot(dx, dy);
    const r1 = sr(source);
    const r2 = sr(target);
    // Stop at the rims, since the translucent fill would show the line inside
    if (length <= r1 + r2) continue;
    const ux = dx / length;
    const uy = dy / length;
    ctx.moveTo(x1 + ux * r1, y1 + uy * r1);
    ctx.lineTo(x1 + dx - ux * r2, y1 + dy - uy * r2);
  }
  ctx.stroke();

  /* Bubbles */
  for (let i = 0; i < placed; i++) {
    const node = model.nodes[i];
    if (!node) continue;
    const x = sx(i);
    const y = sy(i);
    const r = sr(node);
    const emphasized =
      i === frame.hovered || i === frame.selected || frame.highlighted.has(i);
    const { color, alpha } = strokeColor(node, emphasized);

    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.globalAlpha = FILL_ALPHA;
    ctx.fillStyle = COLORS.bone;
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = i === frame.selected ? SELECTED_WIDTH : 1;
    ctx.setLineDash(node.stroke === 'none' ? DASH : NO_DASH);
    ctx.stroke();

    if (node.expired) {
      ctx.beginPath();
      ctx.arc(x + r * DIAGONAL, y - r * DIAGONAL, EXPIRED_DOT_RADIUS, 0, TAU);
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLORS.coral;
      ctx.fill();
    }
  }

  /* Labels */
  ctx.globalAlpha = 1;
  ctx.font = LABEL_FONT;
  ctx.fillStyle = COLORS.ash;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < placed; i++) {
    const node = model.nodes[i];
    if (!node) continue;
    const full =
      node.isRoot ||
      i === frame.hovered ||
      i === frame.selected ||
      i === frame.focused;
    if (!full && !frame.showAllLabels) continue;
    ctx.fillText(
      full ? node.label : node.shortLabel,
      sx(i),
      sy(i) + sr(node) + LABEL_GAP,
    );
  }

  /* Focus ring */
  const focused =
    frame.focused !== null && frame.focused < placed
      ? model.nodes[frame.focused]
      : undefined;
  if (focused) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = COLORS.bone;
    ctx.lineWidth = 1;
    ctx.setLineDash(NO_DASH);
    ctx.beginPath();
    ctx.arc(
      sx(focused.index),
      sy(focused.index),
      sr(focused) + FOCUS_GAP,
      0,
      TAU,
    );
    ctx.stroke();
  }
}

export function createCanvasRenderer(canvas: HTMLCanvasElement): MapRenderer {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx === null) throw new Error('Canvas 2D is unavailable');
  let size = { width: 0, height: 0, dpr: 1 };

  return {
    resize(width, height, dpr) {
      size = { width, height, dpr };
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    },
    draw(frame) {
      drawFrame(ctx, frame, size);
    },
  };
}
