/**
 * QR helper for the phone URL.
 *
 * The left-sidebar panel has to hand the phone a URL that is painful to type
 * (a tunnel host plus an access token), so it shows a scannable code. Encoding
 * runs on the Host and the panel only paints the finished module matrix, which
 * keeps the browser half dependency-free — the Client module format has no
 * package installation of its own.
 *
 * The encoder is qrcode-generator 1.4.4 (MIT, Kazuhiko Arase), vendored
 * verbatim as `vendor/qrcode.cjs`. The `.cjs` extension is load-bearing: this
 * package is `"type": "module"`, so a `.js` copy would be parsed as ESM and its
 * UMD tail (`module.exports = factory()`) would export nothing.
 */

import qrcode from '../vendor/qrcode.cjs'

/** Error-correction level. M tolerates ~15% damage at a size phones still scan. */
export const QR_EC_LEVEL = 'M'

/** Versions 1–10 cover a 90-character URL comfortably; past that, stop. */
const MAX_MODULES = 57

/**
 * Render `text` as a QR module matrix.
 *
 * @param {string} text URL to encode.
 * @returns {{ size: number, rows: string[], ec: string } | null}
 *   `rows[r][c]` is `'1'` for a dark module, `'0'` for a light one. `null` when
 *   there is nothing to encode, the text needs an unreasonable version, or the
 *   encoder throws — a missing QR must never break the panel.
 */
export function qrMatrix(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value.length === 0) return null
  try {
    const code = qrcode(0, QR_EC_LEVEL) // version 0 = smallest version that fits
    code.addData(value)
    code.make()
    const size = code.getModuleCount()
    if (!Number.isFinite(size) || size < 21 || size > MAX_MODULES) return null
    const rows = new Array(size)
    for (let r = 0; r < size; r += 1) {
      let row = ''
      for (let c = 0; c < size; c += 1) row += code.isDark(r, c) ? '1' : '0'
      rows[r] = row
    }
    return { size, rows, ec: QR_EC_LEVEL }
  } catch {
    return null
  }
}
