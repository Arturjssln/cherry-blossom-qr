import { REFERENCE_GRID, VIEW_SCALE_2D, VIEW_SCALE_3D } from '../constants.js';

/**
 * WGSL fragments shared by every pass.
 *
 * All passes read the same uniform block and apply the same camera transform,
 * so the tree, branches, flowers, grass and shadow stay locked together as
 * `progress` animates between the isometric 3D view and the flat QR view.
 */

export const UNIFORMS_WGSL = /* wgsl */ `
struct Uniforms {
  aspectRatio: f32,
  time: f32,
  blockCount: f32,   // reused per-pass as segment / blade / flower count
  progress: f32,     // 0 = 3D tree, 1 = flat QR code
  gridSize: f32,
  cameraBobX: f32,
  cameraBobY: f32,
  season: f32,       // 0 = spring, 1 = summer, 2 = autumn, 3 = winter
}
`;

/** Format a JS {r,g,b} as a WGSL vec3f literal. */
export const vec3 = (c) =>
  `vec3f(${c.r.toFixed(6)}, ${c.g.toFixed(6)}, ${c.b.toFixed(6)})`;

/** Filmic tonemap used by every fragment shader. */
export const ACES_WGSL = /* wgsl */ `
fn acesFilm(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}
`;

/**
 * Camera framing, shared by every pass so the layers can't drift apart.
 *
 * `base` is the 3D -> 2D zoom. The second factor keeps a long message on
 * screen: the world is `gridSize * BLOCK_SIZE` across, so a 177-module
 * version-40 code is ~6x wider than the short URL the framing was tuned for.
 * Codes at or below REFERENCE_GRID keep the tuned scale rather than zooming in.
 */
export const CAMERA_WGSL = /* wgsl */ `
fn viewScaleFor(progress: f32, gridSize: f32) -> f32 {
  let base = mix(${VIEW_SCALE_3D}, ${VIEW_SCALE_2D}, progress);
  return base * (${REFERENCE_GRID.toFixed(1)} / max(gridSize, ${REFERENCE_GRID.toFixed(1)}));
}
`;
