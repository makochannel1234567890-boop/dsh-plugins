/**
 * HTTP plumbing for the phone's "start a session" endpoint.
 *
 * `index.js` owns the routing, the auth check and the session state machine;
 * this module owns the two things that are easy to get wrong and easy to test
 * in isolation: deciding whether a request body is JSON at all, and reading it
 * without ever buffering more than a configured number of bytes.
 *
 * Nothing here touches the filesystem or the Harness context, so every export
 * can be unit-tested with a fake `IncomingMessage`.
 *
 * @module dsh-mobile-progress/lib/session-control
 */

/** Largest request body `POST /api/session` accepts (the prompt is text). */
export const MAX_BODY_BYTES = 64 * 1024

/** Status used when the caller did not attach one to an error. */
const DEFAULT_ERROR_STATUS = 400

/**
 * A request problem the HTTP layer can answer with a status and a stable code.
 *
 * The code (not the message) is the contract the phone page branches on, so it
 * is always one of the strings documented in the plugin README.
 */
export class ControlError extends Error {
  /**
   * @param {string} code stable machine-readable code, e.g. `payload_too_large`
   * @param {string} message short human-readable explanation
   * @param {number} [status] HTTP status to answer with
   */
  constructor(code, message, status = DEFAULT_ERROR_STATUS) {
    super(message)
    this.name = 'ControlError'
    this.code = String(code)
    this.status = Number.isFinite(Number(status)) ? Math.trunc(Number(status)) : DEFAULT_ERROR_STATUS
  }
}

/**
 * Build a `ControlError` without `new` at every call site.
 *
 * @param {string} code
 * @param {string} message
 * @param {number} [status]
 * @returns {ControlError}
 */
export function controlError(code, message, status = DEFAULT_ERROR_STATUS) {
  return new ControlError(code, message, status)
}

/** A positive integer byte budget, or the documented default. */
function resolveMaxBytes(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) return MAX_BODY_BYTES
  return Math.floor(number)
}

/**
 * Is this `content-type` header a JSON media type?
 *
 * Accepts `application/json` with any parameters (`; charset=utf-8`) and the
 * `+json` suffix (`application/merge-patch+json`). Anything else — including a
 * missing header, which is what a phone form post without a body looks like —
 * is not JSON, so the caller answers `415 unsupported_media_type` instead of
 * guessing.
 *
 * @param {string|null|undefined} header the raw `content-type` header
 * @returns {boolean}
 */
export function isJsonContentType(header) {
  if (typeof header !== 'string') return false
  const mediaType = header.split(';', 1)[0].trim().toLowerCase()
  if (mediaType.length === 0) return false
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

/**
 * Read and parse a JSON request body, refusing anything over `maxBytes`.
 *
 * The stream is always drained to its end before an error is raised (an
 * unconsumed body leaves the socket in a state Node reports as a reset), but
 * nothing past the limit is kept in memory.
 *
 * An empty body parses to `{}` so a caller that only forgot the payload gets
 * the endpoint's normal validation error rather than a JSON syntax error.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{maxBytes?: number}} [options]
 * @returns {Promise<unknown>} the parsed JSON value
 * @throws {ControlError} `payload_too_large` (413) or `invalid_json` (400)
 */
export async function readJsonBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  const limit = resolveMaxBytes(maxBytes)

  // A declared length lets an oversized upload be rejected before reading it.
  // The stream is still drained below so the client sees the 413 rather than a
  // connection reset.
  const declared = Number(req?.headers?.['content-length'])
  const tooLarge = Number.isFinite(declared) && declared > limit

  const chunks = []
  let size = 0
  let overflow = tooLarge

  if (req !== null && typeof req === 'object' && typeof req[Symbol.asyncIterator] === 'function') {
    for await (const chunk of req) {
      if (overflow) continue
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > limit) {
        overflow = true
        chunks.length = 0
        continue
      }
      chunks.push(buffer)
    }
  }

  if (overflow) {
    throw controlError('payload_too_large', `request body exceeds ${limit} bytes`, 413)
  }

  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw controlError('invalid_json', 'request body is not valid JSON', 400)
  }
}

/**
 * Run `task` but give up after `timeoutMs`, so one hung prompt cannot tie up
 * the HTTP response forever.
 *
 * The abort is delivered through the returned controller's signal; the caller
 * passes that signal to the session controller.
 *
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} task
 * @param {number} [timeoutMs]
 * @param {string} [reason]
 * @returns {Promise<T>}
 */
export async function withTimeout(task, timeoutMs = 15_000, reason = 'timed out') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(reason)), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    return await task(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Shorten an unknown error to a single log-friendly line.
 *
 * The phone never receives the raw text (it can contain paths or tokens); the
 * log gets a bounded excerpt and the API gets only the stable code.
 *
 * @param {unknown} error
 * @param {number} [max]
 * @returns {string}
 */
export function describeError(error, max = 200) {
  const value = error instanceof Error ? error.message : String(error ?? '')
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}
