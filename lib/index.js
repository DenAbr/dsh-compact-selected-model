/**
 * Route compaction summaries to the model currently selected for the session.
 *
 * The stock summarizer (`@deepseek-ai/dsh-compaction-basic`) sends its one-shot
 * summary call to the provider/model of the LATEST routed request — the model
 * that finished the previous turn. After a switch in the composer model picker,
 * `/compact` and the next pressure compaction therefore still run on the old
 * model. The switch is durable before any request: Session Controller appends a
 * `model/selection` event, and its `modelSelection` projection keeps it as
 * `pending` until a request header consumes it.
 *
 * This plugin intercepts the `llm/stream` waterfall for `purpose: 'compaction'`
 * calls and, when the session has such a pending selection, re-issues the call
 * with the selected provider/model. Everything else in the request (replayed
 * messages, tools, maxTokens, signal) is unchanged. There is no fallback: if the
 * selected model fails, compaction fails with its error; switch back manually
 * and retry. A call that already targets
 * another model than the latest routed one came from an explicit
 * `summarizationProvider`/`summarizationModel` config and is left alone.
 *
 * Written as plain ESM against the shipped harness API (0.1.7-rc.2); no build.
 *
 * @module dsh-compact-selected-model
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'compact-selected-model'

/** The waterfall lives on the LLM runtime; sessions and projections are read softly. */
export const inject = ['llm']

/**
 * Decide where one compaction call should go.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ provider: string, model: string, sessionId?: string }} options - the summarizer's request.
 * @returns {{ provider: string, model: string } | undefined} the selected route, or
 *   undefined to leave the call unchanged.
 */
export function selectedRoute(ctx, options) {
  if (options.sessionId === undefined) return undefined
  const session = ctx.get('sessions')?.get(options.sessionId)
  if (session === undefined) return undefined

  // The stock summarizer falls back to the latest routed request. A call aimed
  // elsewhere was configured explicitly; that choice wins.
  const routed = session.requestHeader()?.config
  if (routed === undefined || !sameRoute(routed, options)) return undefined

  const pending = ctx.get('sessionProjections')?.stateOf(session, 'modelSelection')?.pending
  if (pending == null || pending.provider === '' || pending.model === '') return undefined
  if (sameRoute(pending, options)) return undefined
  return { provider: pending.provider, model: pending.model }
}

/**
 * Install the `llm/stream` interceptor.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  // Calls this plugin issued itself; they pass through the waterfall untouched.
  const rerouted = new WeakSet()

  ctx.on('llm/stream', (options, next) => {
    if (options.purpose !== 'compaction' || rerouted.has(options)) return next()
    let target
    try {
      target = selectedRoute(ctx, options)
    } catch (error) {
      ctx.logger.warn(`could not read the session model selection: ${messageOf(error)}; compacting on ${label(options)}`)
      return next()
    }
    if (target === undefined) return next()

    const request = { ...options, provider: target.provider, model: target.model }
    rerouted.add(request)
    ctx.logger.info(`compaction summary routed to selected model ${label(request)} (turn model ${label(options)})`)
    return ctx.llm.stream(request)
  }, { global: true, prepend: true })
}

function sameRoute(left, right) {
  return left.provider === right.provider && left.model === right.model
}

function label(route) {
  return `${route.provider}/${route.model}`
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
