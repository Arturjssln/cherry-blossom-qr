import {
  BLOCK_SIZE,
  CANOPY_RADIUS_RATIO,
  MAX_GRASS,
  TRUNK_RADIUS_CELLS,
} from '../constants.js';
import { hash } from './noise.js';

/**
 * Scatter grass blades on the dark QR modules that fall *outside* the canopy -
 * the same cells `buildBlockGrid` typed as `BlockType.Grass`. Each blade is one
 * triangle; the shader handles orientation, droop and wind.
 *
 * @param {number} gridSize
 * @param {boolean[][]} qr
 */
export function generateGrass(gridSize, qr) {
  const positions = []; // vec4f: (col, row, seed, height)
  let count = 0;

  const centerCol = gridSize / 2;
  const centerRow = gridSize / 2;
  const canopyRadius = gridSize * CANOPY_RADIUS_RATIO;
  const trunkKeepOut = TRUNK_RADIUS_CELLS * 2;

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize && count < MAX_GRASS; col++) {
      const dx = col - centerCol;
      const dz = row - centerRow;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < trunkKeepOut) continue;
      if (!(qr && qr[row] && qr[row][col])) continue;
      if (dist < canopyRadius) continue;

      const blades = 14 + Math.floor(hash(col, row, 5100) * 8);
      for (let b = 0; b < blades && count < MAX_GRASS; b++) {
        const seed = hash(col, row, 5200 + b);
        const jitterCol = (hash(col, row, 5300 + b) - 0.5) * 0.85;
        const jitterRow = (hash(col, row, 5400 + b) - 0.5) * 0.85;
        const height = BLOCK_SIZE * (0.5 + hash(col, row, 5500 + b) * 1.2);
        positions.push(col + jitterCol, row + jitterRow, seed, height);
        count++;
      }
    }
  }

  return { positions: new Float32Array(positions), count };
}
