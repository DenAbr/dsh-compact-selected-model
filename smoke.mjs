/**
 * Offline self-check (no network, no harness boot).
 *
 * A stand-in `llm` service dispatches the real `llm/stream` waterfall exactly
 * like `LlmRuntime.stream()` (`ctx.waterfall(this, 'llm/stream', options, next)`),
 * and stand-in `sessions` / `sessionProjections` expose the routed request
 * header and the `modelSelection` projection state the plugin reads.
 */
import { Context } from '@deepseek-ai/cordis'
import * as plugin from './lib/index.js'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
  if (!ok) failures.push(label)
}

const TURN = { provider: 'deepseek', model: 'deepseek-chat' }
const PICKED = { provider: 'claude', model: 'claude-opus' }

// Adapter stand-in: records each dispatched route; `failing` routes end in an error.
const calls = []
const failing = new Set()
function adapter(options) {
  calls.push(`${options.provider}/${options.model}`)
  return (async function* () {
    if (failing.has(options.model)) {
      // pi-ai reports usage before an error finish; that must not count as output.
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' } } }
      return
    }
    yield { type: 'text-delta', index: 0, text: `summary by ${options.model}` }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, model: options.model } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

const ctx = new Context()
const llm = {
  stream(options) {
    return ctx.waterfall(this, 'llm/stream', options, () => adapter(options))
  },
}
const session = {
  header: TURN,
  requestHeader() { return this.header === undefined ? undefined : { config: { ...this.header, maxTokens: 4096 } } },
}
let selection = { lastUsed: TURN, pending: PICKED }
for (const [key, value] of Object.entries({
  llm,
  sessions: { get: id => (id === 's1' ? session : undefined) },
  sessionProjections: { stateOf: (s, key) => (s === session && key === 'modelSelection' ? selection : undefined) },
})) {
  ctx.provide(key)
  ctx.set(key, value)
}

async function run(overrides = {}) {
  calls.length = 0
  let text = ''
  let finish
  const usage = []
  for await (const chunk of llm.stream({ ...TURN, messages: [], sessionId: 's1', purpose: 'compaction', ...overrides })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason.kind
    if (chunk.type === 'usage') usage.push(chunk.usage.model ?? 'failed')
  }
  return { calls: [...calls], text, finish, usage }
}

const fiber = ctx.plugin(plugin, {})
await fiber

let r = await run()
check('pending selection reroutes compaction', r.calls.join() === 'claude/claude-opus' && r.text === 'summary by claude-opus' && r.usage.join() === 'claude-opus', JSON.stringify(r))

r = await run({ purpose: undefined })
check('ordinary requests are untouched', r.calls.join() === 'deepseek/deepseek-chat', JSON.stringify(r))

r = await run({ purpose: 'session-title' })
check('other auxiliary purposes are untouched', r.calls.join() === 'deepseek/deepseek-chat', JSON.stringify(r))

r = await run({ provider: 'deepseek', model: 'deepseek-small' })
check('explicit summarization model wins', r.calls.join() === 'deepseek/deepseek-small', JSON.stringify(r))

r = await run({ sessionId: 'unknown' })
check('unknown session is untouched', r.calls.join() === 'deepseek/deepseek-chat', JSON.stringify(r))

selection = { lastUsed: TURN, pending: null }
r = await run()
check('no pending selection keeps the turn model', r.calls.join() === 'deepseek/deepseek-chat', JSON.stringify(r))

selection = { lastUsed: TURN, pending: { ...TURN, reasoningEffort: 'high' } }
r = await run()
check('effort-only selection keeps the turn model', r.calls.join() === 'deepseek/deepseek-chat', JSON.stringify(r))

selection = { lastUsed: TURN, pending: PICKED }
failing.add('claude-opus')
r = await run()
check('selected model error surfaces without fallback',
  r.calls.join() === 'claude/claude-opus' && r.finish === 'error' && r.text === '',
  JSON.stringify(r))
failing.clear()

await fiber.dispose()

r = await run()
check('unload removes the interceptor', r.calls.join() === 'deepseek/deepseek-chat', JSON.stringify(r))

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
