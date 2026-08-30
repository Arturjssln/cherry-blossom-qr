// ---------------------------------------------------------------------------
// Scene constants
// ---------------------------------------------------------------------------

/** Page background (also the colour the sky pass clears to). */
export const BACKGROUND = '#f7f7f7';

/** Encoded when the user hasn't typed anything valid. Any string works. */
export const DEFAULT_CONTENT = 'https://artur.jesslen.ch';

/** Edge length of one voxel in clip-space-ish world units. */
export const BLOCK_SIZE = 0.0245;

/** Radius (in QR cells) of the trunk column at the centre of the grid. */
export const TRUNK_RADIUS_CELLS = 2.5;

/** Canopy covers this fraction of the grid radius. */
export const CANOPY_RADIUS_RATIO = 0.46;

/**
 * Largest grid we can be handed: a version-40 QR code is 177x177 modules.
 * Arbitrary text (not just short URLs) can reach this, so the budgets below
 * are sized for it rather than for a small code.
 */
export const MAX_GRID = 177;

/**
 * Voxel budget. The ground layer is one block per module (MAX_GRID^2 = 31329);
 * trunk, canopy and core stack on top of the dark modules inside the canopy
 * radius. Measured peak across version-40 content is ~94k, so this carries
 * ~40% headroom. The upload path clamps, so overshooting degrades the render
 * rather than throwing.
 */
export const MAX_BLOCKS = 132_000;

/** Storage-buffer budgets for the instanced passes. Peak measured: ~112k. */
export const MAX_FLOWERS = 160_000;
export const MAX_GRASS = 50_000;
export const MAX_BRANCH_SEGMENTS = 500;
export const FALLING_PETAL_COUNT = 10;

// --- Camera ----------------------------------------------------------------
// `progress` lerps 0 (isometric 3D tree) -> 1 (flat top-down QR code).

export const ISO_ANGLE_Y = 0.78;      // yaw in 3D view
export const ISO_ANGLE_X = -0.55;     // pitch in 3D view
export const FLAT_ANGLE_X = -1.5708;  // pitch in 2D view (straight down)
export const VIEW_SCALE_3D = 1.6;
export const VIEW_SCALE_2D = 2.1;

/**
 * The grid size the camera framing was tuned against (a short URL encodes to
 * roughly this). A code's world size is `gridSize * BLOCK_SIZE`, so a long
 * message - up to 177 modules - would otherwise overflow the viewport. See
 * `CAMERA_WGSL`, which zooms out in proportion above this size.
 */
export const REFERENCE_GRID = 29;
export const Y_OFFSET_2D = 0.08;
export const X_OFFSET_2D = 0.015;

// --- Lighting tints injected into the shaders ------------------------------

export const SKY_COLORS = {
  skyZenith:  { r: 0.88, g: 0.78, b: 0.92 },
  skyHorizon: { r: 0.95, g: 0.85, b: 0.9 },
  sun:        { r: 1.12, g: 1.0,  b: 0.95 },
  skyFill:    { r: 0.9,  g: 0.85, b: 0.95 },
  bounce:     { r: 0.55, g: 0.6,  b: 0.5 },
};

/** Voxel material ids, matched by `blockType` in the block shaders. */
export const BlockType = {
  Dirt: 0,
  CherryBlossom: 1,
  Trunk: 2,
  Grass: 3,
  FallenPetals: 4,
  Branch: 5,
};

export const Season = { Spring: 0, Summer: 1, Autumn: 2, Winter: 3 };
