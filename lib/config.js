/**
 * BidKit plugin configuration — declaration, validation and normalization.
 *
 * The bundle is zero-dependency, so `Config` implements the Standard Schema V1
 * interface directly (`Config['~standard'].validate(raw)`), which Cordis runs
 * before `apply` receives the row's config. A malformed value fails loud at
 * activation instead of silently degrading a bid project later.
 *
 * @module lib/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Smallest accepted `defaultTargetWords` (0 keeps the score-derived default). */
export const TARGET_WORDS_MIN = 0
/** Largest accepted `defaultTargetWords`. */
export const TARGET_WORDS_MAX = 200_000

/**
 * @typedef {object} BidkitConfig
 * @property {string} dataDir - absolute root that holds every bid project; empty means `<DSH_HOME>/bidkit/projects`.
 * @property {string} kbDir - absolute root of the enterprise knowledge base; empty disables KB defaults but per-project KB still works.
 * @property {boolean} allowWrite - whether tools may modify a project; false turns every write tool into a read-only error.
 * @property {number} defaultTargetWords - fallback per-section word target; 0 derives it from the scoring weights.
 */

/** @type {BidkitConfig} */
export const DEFAULT_CONFIG = Object.freeze({
  dataDir: '',
  kbDir: '',
  allowWrite: true,
  defaultTargetWords: 0,
})

/** Fields accepted from the patch row. */
export const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG))

/**
 * Build one Standard Schema issue.
 * @param {string} path - config field.
 * @param {string} message - human-readable violation.
 * @returns {{ message: string, path: Array<{ key: string }> }}
 */
function issue(path, message) {
  return { message, path: [{ key: path }] }
}

/**
 * Expand `~` and make a path absolute.
 * @param {string} value - raw path.
 * @returns {string} absolute path.
 */
export function expandPath(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('~')) return join(homedir(), trimmed.slice(1))
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed)
}

/**
 * Validate a raw config row.
 * @param {unknown} raw - value from the loader row.
 * @returns {{ value: BidkitConfig }}
 * @throws {Error} `AggregateError`-like `ConfigError` when invalid.
 */
export function parseConfig(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw configError([issue('', 'config must be an object')])
  }
  const input = /** @type {Record<string, unknown>} */ (source)
  const problems = []
  const value = { ...DEFAULT_CONFIG }

  for (const [key, entry] of Object.entries(input)) {
    if (!CONFIG_KEYS.includes(key)) problems.push(issue(key, `unknown config key "${key}"`))
    else if (entry !== undefined) {
      if (key === 'dataDir' || key === 'kbDir') {
        if (typeof entry !== 'string') problems.push(issue(key, `${key} must be a string`))
        else value[key] = entry.trim() === '' ? '' : expandPath(entry)
      } else if (key === 'allowWrite') {
        if (typeof entry !== 'boolean') problems.push(issue(key, 'allowWrite must be a boolean'))
        else value.allowWrite = entry
      } else if (key === 'defaultTargetWords') {
        const words = Number(entry)
        if (!Number.isFinite(words) || words < TARGET_WORDS_MIN || words > TARGET_WORDS_MAX) {
          problems.push(issue(key, `defaultTargetWords must be a number in [${TARGET_WORDS_MIN}, ${TARGET_WORDS_MAX}]`))
        } else value.defaultTargetWords = Math.trunc(words)
      }
    }
  }

  if (problems.length > 0) throw configError(problems)
  return { value }
}

/**
 * Error carrying Standard Schema issues.
 * @param {Array<{ message: string, path: Array<{ key: string }> }>} issues - violations.
 * @returns {Error & { issues: typeof issues }} error instance.
 */
function configError(issues) {
  const error = new Error(`invalid BidKit config: ${issues.map(entry => entry.message).join('; ')}`)
  error.name = 'ConfigError'
  error.issues = issues
  return error
}

/** Standard Schema V1 view consumed by Cordis before `apply`. */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: /** @type {const} */ (1),
    vendor: 'dsh-plugin-bidkit',
    validate(value) {
      try {
        return { value: parseConfig(value).value }
      } catch (error) {
        return { issues: error.issues ?? [{ message: String(error), path: [] }] }
      }
    },
  }),
})

/**
 * Resolve the project root without touching the filesystem.
 * @param {BidkitConfig} config - validated config.
 * @param {string} [dshHome] - override for `DSH_HOME`.
 * @returns {string} absolute projects directory.
 */
export function resolveDataDir(config, dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  return config.dataDir === '' ? join(dshHome, 'bidkit', 'projects') : config.dataDir
}

/**
 * Resolve the configured knowledge-base root.
 * @param {BidkitConfig} config - validated config.
 * @returns {string|null} absolute KB directory or null when unset.
 */
export function resolveKbDir(config) {
  return config.kbDir === '' ? null : config.kbDir
}
