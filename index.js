/**
 * Host half of BidKit — a native DeepSeek Harness plugin for the tender-bid
 * lifecycle.
 *
 * Contributions, all registered as reversible Cordis effects:
 * - a `bidkit` Host service (the shared `BidRuntime`) for other Host plugins;
 * - seventeen `bid_*` agent tools (`lib/tools.js`);
 * - one prefix route for the workbench (`/dsh-plugin-bidkit/api`, `lib/api.js`).
 *
 * State lives in the workspace filesystem, not in this plugin: a project is a
 * directory, a chapter is a file. That is what makes a multi-hundred-thousand
 * word bid resumable across interruptions, and it is why the plugin adds no
 * second runtime, no database and no bridge process.
 *
 * @module index
 */

import { Config, parseConfig, resolveDataDir, resolveKbDir } from './lib/config.js'
import { BidRuntime } from './lib/runtime.js'
import { registerTools } from './lib/tools.js'
import { API_PREFIX, ApiServer } from './lib/api.js'

export { Config }

/** Cordis plugin name used in diagnostics. */
export const name = 'dsh-plugin-bidkit'

/** Services the Host half cannot do its job without. */
export const inject = ['tools']

/**
 * Register every contribution of the Host half.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [rawConfig] - resolved loader config.
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  const settings = parseConfig(rawConfig).value
  const dataDir = resolveDataDir(settings)
  const log = (message, error) => {
    if (error === undefined) ctx.logger?.info?.(`dsh-plugin-bidkit: ${message}`)
    else ctx.logger?.warn?.(`dsh-plugin-bidkit: ${message} ${error instanceof Error ? error.message : String(error)}`)
  }

  const runtime = new BidRuntime({
    root: dataDir,
    allowWrite: settings.allowWrite,
    defaultTargetWords: settings.defaultTargetWords || 60_000,
    kbDir: resolveKbDir(settings),
    logger: log,
  })

  ctx.effect(() => () => runtime.store.ready().catch(() => undefined), 'bidkit: ensure data root')
  runtime.store.ready().then(
    () => log(`ready — projects in ${dataDir}`),
    error => log('could not create the projects directory', error),
  )

  const disposeService = ctx.provide?.('bidkit', runtime)
  if (typeof disposeService === 'function') ctx.effect(() => disposeService, 'bidkit: service')

  const disposers = registerTools(ctx, runtime)
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'bidkit: tools')

  const api = new ApiServer({
    runtime,
    admit: req => {
      const connection = ctx.get?.('connection')
      return typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : undefined
    },
    log,
  })

  ctx.inject?.(['webServer'], webCtx => {
    if (typeof webCtx.webServer?.register !== 'function') return
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => api.handle(req, res),
    }), `bidkit: ${API_PREFIX}`)
  })

  log(`activated — ${disposers.length} tools, workbench at ${API_PREFIX}`)
}
