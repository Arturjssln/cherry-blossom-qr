import {
  BLOCK_SIZE,
  BlockType,
  CANOPY_RADIUS_RATIO,
  TRUNK_RADIUS_CELLS,
} from '../constants.js';
import { hash } from './noise.js';

/** Height (in voxels) of the trunk before the canopy starts. */
const TRUNK_LAYERS = 12;
const CANOPY_BASE_Y = TRUNK_LAYERS * BLOCK_SIZE;

/**
 * How many canopy voxels stack on a cell, given its normalised distance from
 * the centre (`falloff` = 1 at the trunk, 0 at the canopy edge).
 */
function canopyLayers(falloff) {
  return Math.max(3, Math.round(TRUNK_LAYERS * (0.25 + 0.75 * falloff * falloff)));
}

/**
 * Turn a QR matrix into the voxel field.
 *
 * Layer 0 is the QR code itself - every cell gets a block, and its material is
 * chosen so that in the flat 2D view the dark/light modules read correctly:
 *
 *   dark module  -> Trunk (near centre) / FallenPetals (under canopy) / Grass (outside)
 *   light module -> Dirt
 *
 * Everything above layer 0 is the 3D tree: a trunk column, a domed canopy of
 * cherry-blossom cubes, and a thick core at the trunk base. Those upper voxels
 * are scaled to zero by the vertex shader as `progress` approaches 1, which is
 * what leaves a clean, scannable QR code behind.
 *
 * @param {boolean[][]} qr
 */
export function buildBlockGrid(qr) {
  const size = qr.length;
  const centerCol = size / 2;
  const centerRow = size / 2;

  const positions = []; // vec4f per block: (col, row, 0, 0)
  const heights = [];   // f32 per block
  const baseY = [];     // f32 per block
  const types = [];     // u32 per block
  let count = 0;

  const canopyRadius = size * CANOPY_RADIUS_RATIO;

  // --- Layer 0: the QR code plane -----------------------------------------
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const dx = col - centerCol;
      const dz = row - centerRow;
      const dist = Math.sqrt(dx * dx + dz * dz);

      positions.push(col, row, 0, 0);
      heights.push(BLOCK_SIZE);
      baseY.push(0);

      if (qr[row][col]) {
        if (dist < TRUNK_RADIUS_CELLS) types.push(BlockType.Trunk);
        else if (dist >= canopyRadius) types.push(BlockType.Grass);
        else types.push(BlockType.FallenPetals);
      } else {
        types.push(BlockType.Dirt);
      }
      count++;
    }
  }

  // --- Trunk column --------------------------------------------------------
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!qr[row][col]) continue;
      const dx = col - centerCol;
      const dz = row - centerRow;
      if (Math.sqrt(dx * dx + dz * dz) >= TRUNK_RADIUS_CELLS) continue;

      for (let layer = 1; layer < TRUNK_LAYERS; layer++) {
        positions.push(col, row, 0, 0);
        heights.push(BLOCK_SIZE);
        baseY.push(layer * BLOCK_SIZE);
        types.push(BlockType.Trunk);
        count++;
      }
    }
  }

  // --- Canopy: stacked cherry-blossom cubes --------------------------------
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!qr[row][col]) continue;
      const dx = col - centerCol;
      const dz = row - centerRow;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= canopyRadius) continue;

      const falloff = 1 - dist / canopyRadius;
      const layers = canopyLayers(falloff);
      const lift = Math.floor(falloff * 3) * BLOCK_SIZE; // domes the canopy

      for (let i = 0; i < layers; i++) {
        positions.push(col, row, 0, 0);
        heights.push(BLOCK_SIZE);
        baseY.push(CANOPY_BASE_Y + i * BLOCK_SIZE + lift);
        types.push(BlockType.CherryBlossom);
        count++;
      }

      // A few extra layers so the silhouette isn't a perfect dome.
      const extra = Math.floor(hash(col, row, 500) * 4);
      for (let i = 0; i < extra; i++) {
        positions.push(col, row, 0, 0);
        heights.push(BLOCK_SIZE);
        baseY.push(CANOPY_BASE_Y + (layers + i) * BLOCK_SIZE + lift);
        types.push(BlockType.CherryBlossom);
        count++;
      }
    }
  }

  // --- Solid trunk core (fills the gaps the QR mask leaves) ----------------
  const coreRadius = TRUNK_RADIUS_CELLS * 0.6;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const dx = col - centerCol;
      const dz = row - centerRow;
      if (Math.sqrt(dx * dx + dz * dz) >= coreRadius) continue;

      for (let i = 0; i < 4; i++) {
        positions.push(col, row, 0, 0);
        heights.push(BLOCK_SIZE);
        baseY.push(CANOPY_BASE_Y + i * BLOCK_SIZE);
        types.push(BlockType.Trunk);
        count++;
      }
    }
  }

  return { positions, heights, baseY, types, gridSize: size, numBlocks: count };
}

/**
 * Scatter blossom instances on top of the canopy cube stacks. These are the
 * flowers that "replace" the cubes during the 3D <-> 2D transition, so they sit
 * exactly at the top of each column.
 *
 * Encoding matches the flower shader: `w >= 1` marks a leaf (3 narrow petals),
 * `w < 1` marks a blossom (5 petals, seeded colour).
 *
 * @param {boolean[][]} qr
 */
export function buildCanopyCubeFlowers(qr) {
  const size = qr.length;
  const centerCol = size / 2;
  const centerRow = size / 2;
  const canopyRadius = size * CANOPY_RADIUS_RATIO;

  const positions = []; // vec4f: (col, row, worldY, seed)
  let count = 0;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const dx = col - centerCol;
      const dz = row - centerRow;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= canopyRadius || dist < TRUNK_RADIUS_CELLS) continue;

      const falloff = 1 - dist / canopyRadius;
      const layers = canopyLayers(falloff) + Math.floor(hash(col, row, 500) * 4);
      const lift = Math.floor(falloff * 3) * BLOCK_SIZE;
      const topY = CANOPY_BASE_Y + (layers - 1) * BLOCK_SIZE + lift + BLOCK_SIZE;

      const flowers = 4 + Math.floor(hash(col, row, 600) * 3);
      for (let i = 0; i < flowers; i++) {
        const seed = hash(col, row, 777 + i);
        const jitterCol = (hash(col, row, 800 + i) - 0.5) * 1.2;
        const jitterRow = (hash(col, row, 900 + i) - 0.5) * 1.2;
        const jitterY = (hash(col, row, 1000 + i) - 0.6) * BLOCK_SIZE * 2;
        positions.push(col + jitterCol, row + jitterRow, topY + jitterY, seed);
        count++;
      }

      // Occasional leaf tucked just under the blossoms.
      if (hash(col, row, 1100) < 0.35) {
        const leafSeed = hash(col, row, 1200) + 1; // +1 flags "leaf"
        const jitterCol = (hash(col, row, 1300) - 0.5) * 0.5;
        const jitterRow = (hash(col, row, 1400) - 0.5) * 0.5;
        positions.push(col + jitterCol, row + jitterRow, topY - BLOCK_SIZE, leafSeed);
        count++;
      }
    }
  }

  return { positions, count };
}
