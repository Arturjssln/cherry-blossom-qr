/**
 * Deterministic hash noise in [0, 1). Same formula the shaders use, so CPU-side
 * placement and GPU-side shading stay in sync for a given (x, y, salt).
 */
export function hash(x, y = 0, salt = 0) {
  const v = Math.sin(x * 127.1 + y * 311.7 + salt * 43.7) * 43758.5;
  return v - Math.floor(v);
}
