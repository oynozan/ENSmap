// Every force, size and zoom number the map uses
export const FORCES = {
  // Added to the radii of both ends, so children orbit outside a large parent
  link: { distance: 36, strength: 0.9 },
  charge: { strength: -60, distanceMax: 400 },
  collide: { padding: 3, strength: 0.9, iterations: 2 },
  position: { strength: 0.04 },
  alphaDecay: 0.03,
  velocityDecay: 0.35,
  restTicks: 300,
  ticksPerFrame: 2,
} as const;

export const RADII = {
  root: 26,
  name: 10,
  subname: 5,
  perSqrt: 3,
  max: 48,
} as const;

export const LABEL_ZOOM = 1.4;
export const ZOOM_EXTENT: [number, number] = [0.2, 4];
export const FIT_PADDING = 48;
export const FIT_MAX_ZOOM = 2;
