import QRCode from 'qrcode';
import { DEFAULT_CONTENT } from './constants.js';

/**
 * Error correction level. Higher levels survive more damage but hold less data,
 * so this and MAX_QR_BYTES below have to move together.
 */
export const EC_LEVEL = 'M';

/**
 * Byte-mode capacity of a version-40 QR code at EC level M.
 *
 * This is a *byte* budget, not a character count - one emoji is four bytes.
 * (Level L would allow 2953; Q 1663; H 1273.)
 */
export const MAX_QR_BYTES = 2331;

/** UTF-8 byte length, which is what the QR encoder actually budgets. */
export function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * Encode `text` as a QR code and return it as a boolean matrix. Any string
 * works - URLs, plain text, whatever fits in MAX_QR_BYTES.
 *
 * NOTE: modules are read as `get(col, row)` but stored as `rows[row][col]`,
 * i.e. the matrix comes out transposed relative to the canonical orientation.
 * Most scanners read mirrored codes fine, so this is left as-is.
 *
 * @param {string} text
 * @returns {boolean[][]} `matrix[row][col] === true` for a dark module
 */
export function generateQRMatrix(text) {
  const content = text || DEFAULT_CONTENT;
  try {
    const { modules } = QRCode.create(content, { errorCorrectionLevel: EC_LEVEL });
    const { size } = modules;
    const rows = [];
    for (let row = 0; row < size; row++) {
      const line = [];
      for (let col = 0; col < size; col++) line.push(modules.get(col, row) === 1);
      rows.push(line);
    }
    return rows;
  } catch (err) {
    // Fall back to the default content once; if that fails too, give up loudly.
    if (content === DEFAULT_CONTENT) throw err;
    return generateQRMatrix(DEFAULT_CONTENT);
  }
}
