# dsh-island-go · Island for DSH Go

The [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) "dynamic island" as a **native plugin for DSH Go** (the Android app).

The desktop plugin [`dsh-island`](https://github.com/a961282799-crypto/dsh-island) draws an always-on-top Electron window. An app cannot host a cross-app floating window, so this package draws nothing: it feeds the same engine-side data into the app's native slots.

| Slot | Where | What |
| --- | --- | --- |
| `composer.strip` | one line above the composer (≤ 24 chars) | `Thinking · Context 38% · ¥0.42`, idle: `Idle · Today ¥1.20` |
| `panels` | chat details › Plugins, All features | state, context progress, 7-day token bars, today's tokens / output / cache hits / turns, tokens and cost per model |
| `turn.note` | end of each turn's footnote | that turn's estimated cost, e.g. `¥0.02` |

"Copy summary" on the panel puts the same numbers on the clipboard as plain text.

## Relationship to the desktop plugin

Both packages are independent and can be installed together:

|  | `dsh-island` (desktop) | `dsh-island-go` (this) |
| --- | --- | --- |
| Platform | Windows desktop + Electron runtime | DSH Go app (on-device engine) |
| Form | floating window, tray, motion | status strip + panel + turn note |
| Approvals / questions / stop / chat | yes | no — the app does not let plugins answer approvals or change turn semantics |
| Dependencies | needs Electron | zero dependencies, no build step |

## Install

In the app's Terminal (on-device engine shell):

```sh
dsh plugin --profile web add dsh-island-go
```

Or search「灵动岛 / Island」in `Settings › Plugins › Marketplace`. Takes effect without a restart.

Remote hosts (SSH / relay) have no dsh-go bridge: there the ledger still accumulates, but the strip and panel do not appear.

## Data and privacy

- Reads the engine's own session events: state, plan progress, context window and token counts, model names.
- Ledger lives in `$DSH_HOME/dsh-island-go/usage.json` (default `~/.dsh/dsh-island-go/usage.json`): turns, models, times, tokens and estimated cost, kept 35 days, **no conversation text**.
- No credentials, no network calls, no listening ports.
- Cost is estimated per call from [DeepSeek's official prices](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) (checked 2026-11-22); the bill is authoritative.

## Pricing coverage

| Model | Price source |
| --- | --- |
| `deepseek-flash`, `deepseek-v4-pro` (and the old alias `deepseek-v4-flash`) | Built-in official DeepSeek prices, with peak / off-peak periods |
| Anything else (MIMO, KIMI, MiniMax, GLM, Qwen, other custom providers) | Read at runtime from the model catalog shipped with the engine (`@earendil-works/pi-ai` provider data), converted with `USD / 1M tokens x 7.2` to CNY. Zero-priced subscription plans are skipped rather than treated as free |
| Not found | Shown as "unpriced": tokens are still counted, the cost is left blank |

Override anything in `$DSH_HOME/dsh-island-go/prices.json` (CNY per 1M tokens, highest priority; flat `input` / `output` / `cacheRead`, or `peak` / `offPeak` for time-of-day pricing). Restart the engine to apply; turns that were previously unpriced are repriced on startup.

## Compatibility

Written against the DSH Go 1.1.0 native plugin protocol (`dshGo` v1 in `package.json`, `ctx.dshGo`, the view component catalogue) and the bundled engine `r15-dsh0.2.2-rc.1`; `engines.dsh` is `>=0.2.2-rc.1 <0.3.0-0`.

**Not yet verified on a device**: the three slots' data paths are covered by unit tests (view budget, bindings, manifest consistency), but actual rendering and the bridge handshake need a host with the bridge installed. Please file an [issue](https://github.com/a961282799-crypto/dsh-island-go/issues) if something looks off.

## License

MIT. `state.js` / `usage.js` / `pricing.js` are shared with the desktop plugin.
