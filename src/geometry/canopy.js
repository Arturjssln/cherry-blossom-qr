import { BLOCK_SIZE, CANOPY_RADIUS_RATIO, FALLING_PETAL_COUNT } from '../constants.js';
import { hash } from './noise.js';

const PI = Math.PI;

/**
 * Cloud blossoms around every branch tip, plus a scatter of fallen petals on
 * the ground ring.
 *
 * Positions are stored in *grid* space (col, row) with a world-space Y, because
 * that's the coordinate system the flower vertex shader expects.
 *
 * @param {{x:number,y:number,z:number,radius:number}[]} tips branch endpoints
 * @param {{gridSize:number, canopyDensity:number}} params
 */
export function generateCanopyFlowers(tips, params) {
  const gridSize = params.gridSize;
  const halfGrid = gridSize * BLOCK_SIZE * 0.5;

  const positions = []; // vec4f: (col, row, worldY, seed)
  let count = 0;

  const worldToGrid = (x, z) => ({
    col: (x + halfGrid) / BLOCK_SIZE,
    row: (z + halfGrid) / BLOCK_SIZE,
  });

  for (let i = 0; i < tips.length; i++) {
    const tip = tips[i];
    if (hash(i, 0, 780) < 0.04) continue; // leave a few tips bare

    const sizeVar = 0.8 + hash(i, 3, 790) * 0.6;
    const clusterCount = Math.max(
      12,
      Math.floor(tip.radius * 14 * params.canopyDensity * sizeVar),
    );
    const cloudRadius = tip.radius * BLOCK_SIZE * 3.8 * sizeVar;

    // Main cluster: uniform points in a slightly flattened, widened ball.
    for (let f = 0; f < clusterCount; f++) {
      const seed = hash(i, f, 800);
      const theta = hash(i, f, 810) * PI * 2;
      const cosPhi = hash(i, f, 820) * 2 - 1;
      const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
      const r = cloudRadius * Math.cbrt(hash(i, f, 830));

      const x = tip.x + r * sinPhi * Math.cos(theta) * 1.3;
      const y = tip.y + r * cosPhi * 0.7 + cloudRadius * 0.15;
      const z = tip.z + r * sinPhi * Math.sin(theta) * 1.3;

      const g = worldToGrid(x, z);
      positions.push(g.col, g.row, y, seed);
      count++;
    }

    // A few blossoms hanging below the cluster.
    const hanging = 2 + Math.floor(hash(i, 0, 1500) * 3);
    for (let f = 0; f < hanging; f++) {
      const seed = hash(i, f, 1600);
      const theta = hash(i, f, 1700) * PI * 2;
      const r = cloudRadius * 0.5;
      const x = tip.x + Math.cos(theta) * r;
      const z = tip.z + Math.sin(theta) * r;
      const y = tip.y - BLOCK_SIZE * (0.5 + hash(i, f, 1900) * 2);

      const g = worldToGrid(x, z);
      positions.push(g.col, g.row, y, seed);
      count++;
    }

    // Roughly half the tips also get a leaf (seed >= 1 flags "leaf").
    if (hash(i, 2, 900) < 0.5) {
      const leafSeed = hash(i, 0, 910) + 1;
      const theta = hash(i, 0, 920) * PI * 2;
      const x = tip.x + Math.cos(theta) * cloudRadius * 0.4;
      const z = tip.z + Math.sin(theta) * cloudRadius * 0.4;
      const y = tip.y - BLOCK_SIZE * 0.5;

      const g = worldToGrid(x, z);
      positions.push(g.col, g.row, y, leafSeed);
      count++;
    }
  }

  // --- Petals resting on the ground ----------------------------------------
  const groundRadius = gridSize * CANOPY_RADIUS_RATIO * BLOCK_SIZE;
  const groundY = BLOCK_SIZE * 1.2;

  for (let i = 0; i < 80; i++) {
    const theta = hash(i, 0, 4000) * PI * 2;
    const u = hash(i, 0, 4100);
    const r = groundRadius * (0.1 + u * u * 0.75); // bias toward the trunk
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const seed = hash(i, 0, 4200);

    const g = worldToGrid(x, z);
    positions.push(g.col, g.row, groundY, seed);
    count++;
  }

  return { positions: new Float32Array(positions), count };
}

/**
 * Pick a handful of tips to spawn continuously-falling blossoms from. The
 * falling animation itself (drift, tumble, loop) lives entirely in the shader;
 * this only supplies the origin point and a seed.
 *
 * @param {{x:number,y:number,z:number,radius:number}[]} tips
 * @param {number} gridSize
 * @param {number} count
 */
export function generateFallingPetals(tips, gridSize, count = FALLING_PETAL_COUNT) {
  const halfGrid = gridSize * BLOCK_SIZE * 0.5;
  const positions = [];
  let emitted = 0;

  if (tips.length === 0) {
    return { positions: new Float32Array(count * 4), count: 0 };
  }

  for (let i = 0; i < count; i++) {
    const tip = tips[Math.floor(hash(i, 0, 5000) * tips.length) % tips.length];
    const seed = hash(i, 0, 5100);
    const theta = hash(i, 0, 5200) * PI * 2;
    const r = tip.radius * BLOCK_SIZE * 1.5 * hash(i, 0, 5300);

    const x = tip.x + Math.cos(theta) * r;
    const z = tip.z + Math.sin(theta) * r;
    const y = tip.y + BLOCK_SIZE * (0.5 + hash(i, 0, 5400));

    positions.push((x + halfGrid) / BLOCK_SIZE, (z + halfGrid) / BLOCK_SIZE, y, seed);
    emitted++;
  }

  return { positions: new Float32Array(positions), count: emitted };
}
