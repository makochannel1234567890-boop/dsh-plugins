/**
 * dsh-fanout · model targeting.
 *
 * One place decides which model every session a run creates is switched to, so
 * workers, reviewers and the integrator never inherit a cheap default silently.
 *
 * Three rules keep this honest:
 *   - never invent a provider or model id: read the live catalog the Host
 *     reports, and say so when nothing matches;
 *   - never assume the `ModelSelection` shape: clone the catalog default and
 *     patch only provider/model (and the effort key that default already uses);
 *   - never fail a run because the model could not be switched: the caller gets
 *     `{ ok: false, error }` and the run continues on the inherited model.
 *
 * @module dsh-fanout/lib/model
 */

/** Default target: the flash tier of the 4.1 family. */
export const DEFAULT_MODEL_PATTERN = '4\\.1[\\s._-]*flash'

/** Default reasoning effort the target is pushed to, when the catalog lists it. */
export const DEFAULT_MODEL_EFFORT = 'max'

/** Second chance: any flash tier, so a renamed family still lands somewhere sane. */
export const FALLBACK_MODEL_PATTERN = 'flash'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Compile a pattern, tolerating a broken configuration.
 *
 * @param {unknown} source
 * @returns {RegExp | null}
 */
export function compilePattern(source) {
  if (source instanceof RegExp) return source
  if (typeof source !== 'string') return null
  const text = source.trim()
  if (text.length === 0) return null
  try {
    return new RegExp(text, 'i')
  } catch {
    return null
  }
}

/**
 * Choose the effort id the target should use.
 *
 * Matches the configured effort by id or name first, then `max`-like names, so
 * a catalog that spells it `maximum` or `Max` still resolves.
 *
 * @param {unknown} reasoning
 * @param {string} wanted
 * @returns {string}
 */
export function pickEffort(reasoning, wanted = DEFAULT_MODEL_EFFORT) {
  const efforts = isObject(reasoning) && Array.isArray(reasoning.efforts) ? reasoning.efforts : []
  const rows = efforts.filter((row) => isObject(row) && typeof row.id === 'string' && row.id.length > 0)
  if (rows.length === 0) return ''
  const want = String(wanted ?? '').trim().toLowerCase()
  const exact = rows.find(
    (row) => row.id.toLowerCase() === want || String(row.name ?? '').toLowerCase() === want,
  )
  if (exact) return exact.id
  const loose = rows.find((row) => /max/i.test(row.id) || /max/i.test(String(row.name ?? '')))
  return loose ? loose.id : ''
}

function matches(regex, group, model) {
  const haystack = [model.id, model.name, model.description, `${group.id}/${model.id}`]
  return haystack.some((part) => typeof part === 'string' && part.length > 0 && regex.test(part))
}

function scan(groups, regex, wanted) {
  for (const group of groups) {
    if (!isObject(group) || typeof group.id !== 'string') continue
    const models = Array.isArray(group.models) ? group.models : []
    for (const model of models) {
      if (!isObject(model) || typeof model.id !== 'string' || model.id.length === 0) continue
      if (!matches(regex, group, model)) continue
      return {
        providerId: group.id,
        providerName: typeof group.name === 'string' && group.name.length > 0 ? group.name : group.id,
        modelId: model.id,
        modelName: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
        effortId: pickEffort(model.reasoning, wanted),
      }
    }
  }
  return null
}

/**
 * Resolve the configured target against a live `ModelCatalog`.
 *
 * @param {unknown} catalog value returned by `sessionController.modelCatalog()`
 * @param {{ pattern?: unknown, effort?: unknown }} [options]
 * @returns {{ target: object | null, matchedBy: 'pattern' | 'fallback' | 'none', groups: number }}
 */
export function pickTarget(catalog, options = {}) {
  const groups = isObject(catalog) && Array.isArray(catalog.groups) ? catalog.groups : []
  const wanted = typeof options.effort === 'string' && options.effort.trim().length > 0
    ? options.effort.trim()
    : DEFAULT_MODEL_EFFORT
  const primary = compilePattern(options.pattern) ?? compilePattern(DEFAULT_MODEL_PATTERN)
  const secondary = compilePattern(FALLBACK_MODEL_PATTERN)
  const first = primary ? scan(groups, primary, wanted) : null
  if (first) return { target: first, matchedBy: 'pattern', groups: groups.length }
  const second = secondary ? scan(groups, secondary, wanted) : null
  if (second) return { target: second, matchedBy: 'fallback', groups: groups.length }
  return { target: null, matchedBy: 'none', groups: groups.length }
}

/**
 * Build the selections to try, exact-shape first.
 *
 * The catalog default is cloned because it is the one object guaranteed to
 * satisfy `ModelSelection` for this deployment. The effort patch is attempted
 * only in the shape that default already uses, and a second candidate without
 * it lets the caller retry instead of losing the model switch.
 *
 * @param {unknown} base the catalog default selection
 * @param {object} target a `pickTarget().target`
 * @returns {Array<object>}
 */
export function buildSelections(base, target) {
  if (!isObject(target)) return []
  const selection = isObject(base) ? { ...base } : {}
  selection.provider = target.providerId
  selection.model = target.modelId
  const plain = { ...selection }
  let patched = null
  if (typeof target.effortId === 'string' && target.effortId.length > 0) {
    if (isObject(selection.reasoning)) {
      patched = { ...selection, reasoning: { ...selection.reasoning, effort: target.effortId } }
    } else if (typeof selection.effort === 'string') {
      patched = { ...selection, effort: target.effortId }
    } else if (isObject(selection.reasoningEffort)) {
      patched = { ...selection, reasoningEffort: { ...selection.reasoningEffort, effort: target.effortId } }
    }
  }
  return patched ? [patched, plain] : [plain]
}

/**
 * Human-facing label for a resolved target, safe to render and to log.
 *
 * @param {unknown} target
 * @returns {string}
 */
export function describeTarget(target) {
  if (!isObject(target)) return ''
  const provider = typeof target.providerId === 'string' ? target.providerId : ''
  const model = typeof target.modelId === 'string' ? target.modelId : ''
  const effort = typeof target.effortId === 'string' && target.effortId.length > 0 ? ` · ${target.effortId}` : ''
  if (model.length === 0) return ''
  return provider.length > 0 ? `${provider}/${model}${effort}` : `${model}${effort}`
}

/**
 * Switch one session to the target, trying each shape in order.
 *
 * @param {object} controller the `sessionController` service
 * @param {string} sessionId
 * @param {Array<object>} selections from `buildSelections`
 * @returns {Promise<{ ok: boolean, selected?: object, effort: boolean, error?: string }>}
 */
export async function applySelection(controller, sessionId, selections) {
  if (!isObject(controller) || typeof controller.selectModel !== 'function') {
    return { ok: false, effort: false, error: 'selectModel is unavailable in this composition' }
  }
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    return { ok: false, effort: false, error: 'session id is required' }
  }
  const candidates = Array.isArray(selections) ? selections.filter(isObject) : []
  if (candidates.length === 0) return { ok: false, effort: false, error: 'no model selection' }
  let lastError = ''
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      const result = await controller.selectModel({ sessionId: sessionId.trim(), ...candidates[index] })
      return {
        ok: true,
        selected: isObject(result) && isObject(result.selected) ? result.selected : candidates[index],
        effort: index === 0 && candidates.length > 1,
      }
    } catch (error) {
      lastError = String(error?.message ?? error)
    }
  }
  return { ok: false, effort: false, error: lastError || 'selectModel failed' }
}
