# dsh-compact-selected-model

By default, DeepSeek Harness compacts a session with the model that answered the
last turn. If you switch models in the picker and then run `/compact`, the old
model still writes the summary. With this plugin, the summary is written by the
model you have selected now.

Works with dsh 0.1.7-rc.2 through 0.2.x.

## Install

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-compact-selected-model
```

Then restart `dsh web`.

## How it works

Picking a model in the web UI adds a `model/selection` event to the session.
That choice stays pending until the next request uses it. The plugin hooks
`llm/stream`. When a request has `purpose: 'compaction'` and the session has a
pending model, the plugin sends the request to that model. Nothing else in the
request changes.

The plugin leaves the request alone if `compaction-basic` has an explicit
`summarizationModel` set. Other requests are never touched.

If the selected model fails, for example because of a rate limit or a context
window that is too small, the compaction fails too. Switch back to a working
model and run `/compact` again.

## Caveats

- The `compaction/summary` event in the session log still names the old model,
  because compaction-basic writes that record itself. The host log shows where
  the request actually went.
- The auto-compaction threshold is still based on the context window of the
  previous model.
- This needs the `modelSelection` projection from the session controller, so it
  does nothing in headless runs.

## Development

`node smoke.mjs` runs an offline check against a stub LLM service.

## License

MIT
