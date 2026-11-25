# R_10 frozen transition / low-volatility forward test

## Frozen identity and safety boundary

- Strategy/provider: `volatility10_transition_lowvol_1r_forward_v1`
- Instrument: Deriv Volatility 10 Index, `R_10` only. Volatility 10 (1s) is not accepted.
- Signal-only forward test. Alerts are sent only through the configured Telegram Worker.
- `brokerExecutionAllowed=false`, `paper=true`, `live=false` are mandatory schema fields.
- R_10 is excluded from the Worker MT5 allow-list, direct Durable Object broker queue insertion, and the MT5 EA symbol map/allow-list.
- No broker order, MT5 order, or execution queue item may be created by this strategy.
- The old EMA/ATR source file remains in the repository for audit/rollback comparison; it is not the provider identity for this forward test.

## Candle construction and no-look-ahead rules

The scanner requests completed M1 candles for `R_10` from the existing Deriv public WebSocket candle-history interface. It does not request the 1-second product. M5, H1 and H4 bars are aggregated only from contiguous, complete M1 candles aligned to UTC timeframe boundaries.

A swing uses two candles on its left and two on its right. The pivot is not exposed until the second right-side candle has closed. The confirmation timestamp is the close epoch of that second right-side candle. Structure classification filters swings by `confirmedAt <= signalTimestamp`; later-confirmed pivots cannot affect an earlier signal. H4 and H1 are bullish only when the latest confirmed high and low are both higher than their preceding confirmed equivalents, bearish only when both are lower, otherwise neutral. A signal is allowed only when H4/H1 are not both bullish and not both bearish.

The scanner initializes a forward cursor at its first healthy run and never sends historical catch-up signals. It evaluates only newly completed M5 setup candles. A setup is evaluated at its close epoch, and the next M1 candle must start at that exact epoch to supply the observed reference open.

## Frozen entry conditions

- M5 ATR(14): Wilder ATR.
- Volatility rank: current setup ATR ranked against the preceding 500 valid M5 ATR observations only. The current ATR is excluded from the reference window. Warm-up therefore requires 500 prior valid ATR values plus the ATR(14) initialization history. Until ready, the setup is skipped as `atr_percentile_warmup`.
- Accept only percentile strictly below 0.33.
- Evaluate at UTC hours 16, 18, 19 and 20, based on the M5 setup close / next entry M1 open timestamp. Timestamps use Deriv server Unix epochs and JavaScript UTC methods; local timezone is not used.
- Sweep lookback: prior 10 completed M5 candles, excluding the current setup candle.
- BUY: current low below prior 10-candle low, bullish close, body at least 0.8 x ATR.
- SELL: current high above prior 10-candle high, bearish close, body at least 0.8 x ATR.
- Entry reference: open of the next M1 candle whose epoch equals the completed M5 setup close. Entry delay over 60 seconds, missing entry candle, duplicate setup, active trade, invalid stop, insufficient history or non-qualifying regime is recorded as skipped.
- BUY stop: sweep low minus 0.10 x ATR. SELL stop: sweep high plus 0.10 x ATR. The stop must be beyond the sweep and on the correct side of entry.
- Target: exactly 1R from entry. No TP2, partial exit, breakeven, or trailing stop.
- One active forward-test trade at a time.
- M1 outcome monitoring: first stop/target touch wins the ordering; both touched in the same M1 candle is AMBIGUOUS. A missing M1 candle is UNRESOLVED. After 120 M1 candles (24 M5 candles), an untouched trade is EXPIRED.

## Journal and delivery

Files:
- `volatility10_transition_forward_state.json`
- `volatility10_transition_forward_journal.json`

The journal stores strategy version, signal ID, UTC timestamp, direction, H4/H1 structure, M5 sweep details, ATR/percentile, entry/stop/target, spread/quote age, entry delay, Telegram status, outcome, exit timestamp/price, reason, data-gap/stale/ambiguous flags and bounded error details. Spread and quote age are null when unavailable from the candle source; no values are fabricated.

Only signals no older than 60 seconds are sent. The Telegram Worker checks the exact strategy identity, M5 timeframe, forward-test marker, paper-only fields, 1R level ordering and volatility percentile. It uses a Durable Object reservation/acknowledgement record for duplicate prevention and retry after delivery failure. The signal route does not call the MT5 queue. Historical catch-up is suppressed.

## Feature flags and secrets

All flags are fail-closed by default.

GitHub Actions variables:
- `R10_PAPER_PROVIDER_ENABLED=true` — allow the scanner process to run.
- `R10_EMERGENCY_KILL_SWITCH=false` — release the scanner emergency stop.
- `R10_PAPER_TELEGRAM_ENABLED=true` — allow scanner-side delivery attempts.
- `R10_PAPER_ROUTE_ENABLED=true` — allow the workflow to pass the route gate.
- `R10_LEGACY_ROLLBACK_ENABLED=false` — retain the new strategy; set true only to select the previous R10 EMA/ATR paper scanner.

GitHub Actions secrets (existing names; do not print values):
- `TELEGRAM_WORKER_URL`
- `SIGNAL_API_KEY`

Cloudflare `deriv-telegram-alerts` Worker:
- Existing `SIGNAL_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` secrets and `EXECUTION_QUEUE` Durable Object binding must remain configured.
- `R10_PAPER_ROUTE_ENABLED=true`
- `R10_EMERGENCY_KILL_SWITCH=false`
- Keep `MT5_EXECUTION_ENABLED=false`. R_10 remains rejected even if MT5 observation or execution is enabled for other markets.

Cloudflare `deriv-mtf-watchdog` Worker:
- Existing `R10_PAPER_SCHEDULER_ENABLED`, `R10_PAPER_PROVIDER_ENABLED`, `R10_EMERGENCY_KILL_SWITCH`, GitHub token and state binding remain as previously configured.
- The scheduler dispatch now passes the separate route-enabled input to the scanner. The Telegram Worker still independently gates delivery.

## Rollback

**To stop all R_10 activity immediately:**

1. Set `R10_EMERGENCY_KILL_SWITCH=true` in GitHub Actions, the `deriv-mtf-watchdog` Worker and the `deriv-telegram-alerts` Worker.
2. Set `R10_PAPER_PROVIDER_ENABLED=false` in GitHub Actions and the watchdog; set `R10_PAPER_SCHEDULER_ENABLED=false` on the watchdog.
3. Set `R10_PAPER_TELEGRAM_ENABLED=false`, `R10_PAPER_ROUTE_ENABLED=false` and `R10_LEGACY_ROLLBACK_ENABLED=false`.

**To restore the previous R_10 EMA/ATR paper scanner (without restoring broker execution):**

1. Keep the MT5 R_10 exclusion in place. Never restore R_10 to `MT5_ALLOWED_MARKETS`, `AllowedMarkets`, `InpSymbolMap`, or the direct bot market list.
2. Set `R10_LEGACY_ROLLBACK_ENABLED=true` in GitHub Actions variables, the `deriv-mtf-watchdog` Worker and the `deriv-telegram-alerts` Worker.
3. Set `R10_PAPER_PROVIDER_ENABLED=true`, `R10_PAPER_SCHEDULER_ENABLED=true`, `R10_PAPER_TELEGRAM_ENABLED=true`, and `R10_PAPER_ROUTE_ENABLED=true`; set `R10_EMERGENCY_KILL_SWITCH=false` in the respective GitHub/Cloudflare environments.
4. The workflow selects the retained `volatility10_paper_scanner.js` and the Worker accepts only the previous paper schema while the rollback flag is active. The Worker still rejects R_10 from MT5 validation and the Durable Object order queue.
5. To return to the frozen strategy, set `R10_LEGACY_ROLLBACK_ENABLED=false`; the next workflow dispatch selects `volatility10_transition_forward_scanner.js`.

Do not revert the entire PR as a rollback action: that would also restore the former R_10 broker allow-list entries. Preserve the R_10 execution exclusions and forward-test journals. If source rollback is necessary, revert only the R_10 strategy/notification implementation while retaining the MT5, broker queue and direct-bot R_10 exclusions.

## Known limitations before production activation

- The Deriv candle feed does not provide bid/ask spread or a tick-age quote in the current scanner contract. Those journal fields are explicitly null. Entry delay is recorded from Deriv server time. No independent material-displacement threshold was specified, so the scanner does not invent one.
## Historical M1 smoke test (Deepnote, 25 Nov 2026)

The existing Deepnote project `MT5 Gold Scalping Research — XAUUSD` already contained `Volatility 10 Index_M1.csv`; no re-upload or M15 upsampling was used. The separate smoke-test notebook and its output files are in that project.

- Source coverage: 1,030,265 M1 rows, 2024-12-01 00:00 through 2026-11-16 13:22 (naive timestamps).
- Integrity: zero duplicate timestamps, zero invalid OHLC rows, 33 missing-minute intervals (largest 21 minutes), split into 34 continuous segments. Thirty-one segments had at least 2,700 M1 candles.
- Derived complete bars: 205,295 M5, 17,081 H1 and 4,248 H4.
- Frozen-rule reference replay: 692 prefilter candidates; 80 non-overlapping signals generated after the exact filters and one-active-trade rule.
- Outcomes: 44 WIN, 36 LOSS; 55.0% win rate, +8.0R gross aggregate, +0.10R gross expectancy per signal, gross profit factor 1.22. All 80 reached a terminal stop/target outcome within the 24-M5-bar limit; no ambiguous, unresolved, expired or pending outcomes occurred in this sample.
- This is an uncosted historical reference replay, not evidence of a profitable live strategy. It uses the next M1 open as a reference entry and does not include spread, slippage, commission, or a verified executable quote.
- Historical replay assumes the scanner evaluates 30 seconds after the M5 close. It does not simulate live tick timing or a price-displacement check against the reference open.
- The Deepnote runtime has no Node.js binary. The full-history replay therefore used a Python reference implementation mirroring the frozen JavaScript strategy rules; the repository's JavaScript unit/integration suite remains separately tested (383 passed, 0 failed). The historical replay is not represented as direct execution of the JavaScript module.
- Look-ahead control: M5/H1/H4 were derived from complete M1 buckets within contiguous segments. Swing pivots use two right-hand candles and are admitted only when their confirmation epoch is at or before the setup close. The historical replay asserts confirmation occurs after the pivot candle.
- Timezone remains unverified for the historical CSV: source timestamps are naive. The live scanner itself uses the Deriv WebSocket `time` response (Unix epoch) and JavaScript UTC methods; the MT5 server offset is needed to map the historical MT5 export onto those Deriv UTC epochs, not to set the live scanner clock. UTC hour filtering and epoch-aligned bucket boundaries in the historical replay are therefore provisional until a matching historical M1 bar is compared across MT5 and Deriv.
- Spread convention remains unverified: all 1,030,265 rows have an integer raw spread value (42 distinct values; min 122, median 167, p95/max 188). The monthly median ranges from 139 to 188 and the values are not a constant spread. The MT5-style `<SPREAD>` column label is not sufficient by itself to establish the historical point conversion or bid/ask basis for this export. No spread cost was applied.
- A read-only MT5 diagnostic is available in the Deepnote project at `mt5_diagnostics/Volatility10_SymbolClockSpreadDiagnostic.mq5`. It logs exact symbol, Digits, Point, tick size, Bid/Ask, spread points and price, chart mode, broker server, TimeTradeServer, TimeGMT, current offset and latest M1 bar open. The current offset alone does not establish historical offset; compare a known M1 bar timestamp in MT5 with the same bar in the Deriv API/export.
- Smoke-test artefacts: `r10_transition_forward_v1_historical_signals.csv` and `r10_transition_forward_v1_historical_summary.json` in Deepnote.

Deepnote notebook: https://deepnote.com/workspace/deriv-quantitative-r-a4a0ca65-624b-4f3e-abcd-2c60b69d0ea5/project/MT5-Gold-Scalping-Research-XAUUSD-fc808e29-de21-4326-96d6-9548f5dabaf7/notebook/R10-Frozen-Transition-Low-Vol-1R-Historical-Smoke-Test-9603033890c7458083bdd3702c6a77d6?utm_content=fc808e29-de21-4326-96d6-9548f5dabaf7
- A 5,000-candle M1 fetch is the scanner's current history request. The latest continuous segment must contain at least 2,700 M1 candles to satisfy the 500-prior-ATR warm-up and higher-timeframe structure availability.
- No forward-test start time is claimed until the deployed scanner initializes its live cursor and writes `startedAt`.
- No deployment is performed by this branch. Cloudflare Worker and watchdog deployments require the existing authorized deployment process and confirmation of current bindings/secrets.
