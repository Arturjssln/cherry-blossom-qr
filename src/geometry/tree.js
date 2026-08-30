import {
  BLOCK_SIZE,
  CANOPY_RADIUS_RATIO,
  MAX_BRANCH_SEGMENTS,
  REFERENCE_GRID,
} from '../constants.js';
import { hash } from './noise.js';

const PI = Math.PI;

// Segment budget guards. The branch buffer holds MAX_BRANCH_SEGMENTS entries;
// these thresholds leave headroom for the recursive twigs each call can add.
const RECURSION_BUDGET = MAX_BRANCH_SEGMENTS - 15; // 485
const BRANCH_START_BUDGET = MAX_BRANCH_SEGMENTS - 30; // 470
const BRANCH_STEP_BUDGET = MAX_BRANCH_SEGMENTS - 25; // 475

/**
 * Derive the tree's shape from the QR code itself, so a given input always
 * grows the same tree and different inputs grow visibly different ones.
 *
 * `density`   = fraction of dark modules
 * `edgeRatio` = fraction of neighbouring cells that differ (visual "busyness")
 *
 * @param {boolean[][]} qr
 */
export function deriveTreeParams(qr) {
  const size = qr.length;
  let dark = 0;
  let edges = 0;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr[row][col]) dark++;
      if (col > 0 && qr[row][col] !== qr[row][col - 1]) edges++;
      if (row > 0 && qr[row][col] !== qr[row - 1][col]) edges++;
    }
  }

  const cells = size * size;
  const edgePairs = 2 * size * (size - 1);
  const density = dark / cells;
  const edgeRatio = edges / edgePairs;

  // The canopy radius is a fraction of the grid, so it grows with the code -
  // but the trunk is sized in world units. Left alone, a long message gives a
  // wide canopy on a stubby trunk (a pancake). Scale the trunk to match.
  // Clamped like the camera: grids at or below REFERENCE_GRID are untouched,
  // so short input keeps exactly the tuned proportions.
  const gridScale = Math.max(size, REFERENCE_GRID) / REFERENCE_GRID;

  return {
    gridSize: size,
    density,
    edgeRatio,
    trunkHeight: (0.26 + density * 0.08) * gridScale,
    trunkRadius: (0.024 + density * 0.008) * gridScale,
    trunkLean: (0.04 + hash(density, edgeRatio) * 0.03) * gridScale,
    mainBranches: 4 + Math.floor(density * 4),
    branchSpread: 0.5 + edgeRatio * 0.5,
    branchLengthScale: 0.55 + density * 0.25,
    maxDepth: edgeRatio > 0.28 ? 5 : 4,
    canopyDensity: 0.5 + density * 0.5,
  };
}

/**
 * Grow the branch skeleton: a leaning trunk, a ring of main lateral branches, a
 * crown of upward shoots, and recursively forked twigs.
 *
 * Each segment is packed as three vec4f for the branch storage buffer:
 *   [ start.xyz, startRadius ]
 *   [ end.xyz,   endRadius   ]
 *   [ depth, seed, 0, 0      ]
 *
 * `tips` are the branch endpoints; the canopy generator clouds blossoms around
 * them, so the flowers actually sit on the branches rather than floating.
 *
 * @param {ReturnType<typeof deriveTreeParams>} params
 * @param {number} gridSize
 */
export function generateBranchSkeleton(params, gridSize) {
  const canopyR = gridSize * CANOPY_RADIUS_RATIO * BLOCK_SIZE;
  const {
    trunkHeight,
    trunkRadius,
    trunkLean,
    mainBranches,
    branchLengthScale,
    maxDepth,
  } = params;

  const segments = [];
  const tips = [];
  let segCount = 0;

  const pushSegment = (sx, sy, sz, sr, ex, ey, ez, er, depth, seed) => {
    segments.push(sx, sy, sz, sr, ex, ey, ez, er, depth, seed, 0, 0);
    segCount++;
  };

  // --- Trunk: 10 tapering, gently S-curved segments ------------------------
  for (let i = 0; i < 10; i++) {
    const t0 = i / 10;
    const t1 = (i + 1) / 10;
    const bulge0 = 1 + Math.sin(t0 * PI * 0.8) * 0.08;
    const bulge1 = 1 + Math.sin(t1 * PI * 0.8) * 0.08;
    const r0 = trunkRadius * (1 - t0 * 0.55) * bulge0;
    const r1 = trunkRadius * (1 - t1 * 0.55) * bulge1;
    const x0 = trunkLean * t0 * t0 + trunkLean * 0.3 * Math.sin(t0 * PI * 1.5);
    const z0 = trunkLean * 0.5 * Math.sin(t0 * PI * 0.8);
    const x1 = trunkLean * t1 * t1 + trunkLean * 0.3 * Math.sin(t1 * PI * 1.5);
    const z1 = trunkLean * 0.5 * Math.sin(t1 * PI * 0.8);
    pushSegment(x0, t0 * trunkHeight, z0, r0, x1, t1 * trunkHeight, z1, r1, 0, t0 * 0.5);
  }

  /** Point on the trunk centreline at normalised height `t`. */
  const trunkPointAt = (t) => ({
    x: trunkLean * t * t + trunkLean * 0.3 * Math.sin(t * PI * 1.5),
    y: trunkHeight * t,
    z: trunkLean * 0.5 * Math.sin(t * PI * 0.8),
  });

  const canopyTopY = trunkHeight + canopyR * 0.9;

  /** Keep a branch tip inside the canopy silhouette. */
  const clampToCanopy = (x, z) => {
    const r = Math.sqrt(x * x + z * z);
    const limit = canopyR * 0.95;
    if (r > limit) return [x * (limit / r), z * (limit / r)];
    return [x, z];
  };

  /**
   * Emit one segment then fork 1-2 child twigs from its endpoint, each of which
   * may fork once more when `maxDepth >= 4`.
   */
  function growBranch(sx, sy, sz, sr, ex, ey, ez, er, angle, depth) {
    if (segCount >= RECURSION_BUDGET) return;
    pushSegment(sx, sy, sz, sr, ex, ey, ez, er, depth, hash(segCount, 0, 400));

    const children = 1 + Math.floor(hash(segCount, 0, 500) * 2);
    for (let i = 0; i < children && segCount < RECURSION_BUDGET; i++) {
      const ang = angle + (hash(segCount, i, 600) - 0.5) * 2;
      const len = canopyR * (0.15 + hash(segCount, i, 700) * 0.2) * branchLengthScale;
      const pitch = 0.15 + hash(segCount, i, 750) * 0.6;
      const baseR = er * (0.5 + hash(segCount, i, 800) * 0.2);

      let nx = ex + Math.cos(ang) * Math.cos(pitch) * len;
      const ny = ey + Math.sin(pitch) * len;
      let nz = ez + Math.sin(ang) * Math.cos(pitch) * len;
      [nx, nz] = clampToCanopy(nx, nz);
      const tipR = baseR * 0.4;

      const seed = hash(segCount, i, 850);
      pushSegment(ex, ey, ez, baseR, nx, ny, nz, tipR, depth + 1, seed);
      tips.push({ x: nx, y: ny, z: nz, radius: tipR * 25 });

      if (maxDepth >= 4 && segCount < RECURSION_BUDGET) {
        const ang2 = ang + (hash(segCount, i, 860) - 0.5) * 2;
        const len2 = len * 0.45;
        const pitch2 = 0.3 + hash(segCount, i, 870) * 0.5;
        const twigR = tipR * 0.5;

        let tx = nx + Math.cos(ang2) * Math.cos(pitch2) * len2;
        const ty = ny + Math.sin(pitch2) * len2;
        let tz = nz + Math.sin(ang2) * Math.cos(pitch2) * len2;
        [tx, tz] = clampToCanopy(tx, tz);

        const seed2 = hash(segCount, i, 880);
        pushSegment(nx, ny, nz, tipR, tx, ty, tz, twigR * 0.3, depth + 2, seed2);
        tips.push({ x: tx, y: ty, z: tz, radius: twigR * 15 });
      }
    }
  }

  // --- Crown: upward shoots from just below the trunk apex ------------------
  const crownCount = 3 + Math.floor(hash(0, 0, 2000) * 2);
  const apex = trunkPointAt(0.95);

  for (let b = 0; b < crownCount && segCount < BRANCH_START_BUDGET; b++) {
    const ang = (b / crownCount) * PI * 2 + hash(b, 0, 2100) * 0.5;
    const reach = canopyR * (0.1 + hash(b, 0, 2200) * 0.25);
    const startR = trunkRadius * (0.3 + hash(b, 0, 2300) * 0.12);
    // NOTE: hash() is in [0,1) so this floors to 0 -> always 2 steps.
    // Left alone deliberately: changing it changes the silhouette.
    const steps = 2 + Math.floor(hash(b, 0, 2400));

    let cx = apex.x;
    let cy = apex.y;
    let cz = apex.z;
    let cr = startR;

    for (let s = 0; s < steps && segCount < BRANCH_STEP_BUDGET; s++) {
      const t = (s + 1) / steps;
      const jx = (hash(b, s, 2500) - 0.5) * 0.01;
      const jz = (hash(b, s, 2600) - 0.5) * 0.01;
      const nx = apex.x + Math.cos(ang) * reach * t + jx;
      const ny = apex.y + (canopyTopY - apex.y) * t * (0.7 + hash(b, s, 2700) * 0.3);
      const nz = apex.z + Math.sin(ang) * reach * t + jz;
      const nr = cr * (0.5 + hash(b, s, 2800) * 0.1);

      pushSegment(cx, cy, cz, cr, nx, ny, nz, nr, 1, hash(b, s, 2900));
      cx = nx; cy = ny; cz = nz; cr = nr;
    }

    tips.push({ x: cx, y: cy, z: cz, radius: cr * 35 });
    growBranch(
      cx, cy, cz, cr * 0.7,
      cx + (hash(b, 0, 3000) - 0.5) * canopyR * 0.3,
      cy + canopyR * 0.1,
      cz + (hash(b, 0, 3100) - 0.5) * canopyR * 0.3,
      cr * 0.3,
      ang, 2,
    );
  }

  // --- Main lateral branches, arcing out from the upper trunk ---------------
  for (let b = 0; b < mainBranches && segCount < BRANCH_START_BUDGET; b++) {
    const origin = trunkPointAt(0.7 + hash(b, 0, 1200) * 0.25);
    const ang = (b / mainBranches) * PI * 2 + (hash(b, 0, 900) - 0.5) * 0.4;
    const reach = canopyR * (0.6 + hash(b, 0, 1000) * 0.35);
    const endY = trunkHeight * (0.85 + hash(b, 0, 1050) * 0.35);
    const targetX = Math.cos(ang) * reach;
    const targetZ = Math.sin(ang) * reach;

    let cx = origin.x;
    let cy = origin.y;
    let cz = origin.z;
    let cr = trunkRadius * (0.4 + hash(b, 0, 1100) * 0.15);

    for (let s = 0; s < 3 && segCount < BRANCH_STEP_BUDGET; s++) {
      const t = (s + 1) / 3;
      const arc = Math.sin(t * PI) * canopyR * 0.3; // lifts the middle of the branch
      const jx = (hash(b, s, 150) - 0.5) * 0.015;
      const jz = (hash(b, s, 250) - 0.5) * 0.015;
      const nx = origin.x + (targetX - origin.x) * t + jx;
      const ny = origin.y + (endY - origin.y) * t + arc * (1 - t);
      const nz = origin.z + (targetZ - origin.z) * t + jz;
      const nr = cr * (0.55 + hash(b, s, 350) * 0.1);

      pushSegment(cx, cy, cz, cr, nx, ny, nz, nr, 1, hash(b, s, 400));

      if (s >= 1 && segCount < BRANCH_START_BUDGET) {
        growBranch(
          nx, ny, nz, nr * 0.6,
          nx + (hash(b, s, 610) - 0.5) * canopyR * 0.4,
          ny + canopyR * (0.1 + hash(b, s, 620) * 0.15),
          nz + (hash(b, s, 630) - 0.5) * canopyR * 0.4,
          nr * 0.25,
          ang, 2,
        );
      }

      cx = nx; cy = ny; cz = nz; cr = nr;
    }

    tips.push({ x: cx, y: cy, z: cz, radius: cr * 30 });
  }

  return { segments: new Float32Array(segments), segmentCount: segCount, tips };
}
