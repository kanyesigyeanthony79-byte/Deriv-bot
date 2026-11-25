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

1. Set `R10_EMERGENCY_KILL_SWITCH=true` in GitHub Actions, the watchdog Worker and the Telegram Worker.
2. Set `R10_PAPER_PROVIDER_ENABLED=false` in GitHub Actions and the watchdog; set `R10_PAPER_SCHEDULER_ENABLED=false` on the watchdog.
3. Set `R10_PAPER_TELEGRAM_ENABLED=false` and `R10_PAPER_ROUTE_ENABLED=false`.
4. For source rollback, revert the forward-test PR/commit. To restore the previous R_10 signal provider, use the previous provider implementation and its matching worker/schema revision. Do not restore R_10 to the MT5 allow-list; the broker exclusion is permanent for this forward test and must remain in place.
5. Preserve the forward-test journal files for audit; do not overwrite or delete the record.

## Known limitations before production activation

- The Deriv candle feed does not provide bid/ask spread or a tick-age quote in the current scanner contract. Those journal fields are explicitly null. Entry delay is recorded from Deriv server time. No independent material-displacement threshold was specified, so the scanner does not invent one.
- The supplied M1 dataset has not yet been located in this repository; the historical smoke test remains blocked until its exact path/data file is supplied or found.
- A 5,000-candle M1 fetch is the scanner's current history request. The latest continuous segment must contain at least 2,700 M1 candles to satisfy the 500-prior-ATR warm-up and higher-timeframe structure availability.
- No forward-test start time is claimed until the deployed scanner initializes its live cursor and writes `startedAt`.
- No deployment is performed by this branch. Cloudflare Worker and watchdog deployments require the existing authorized deployment process and confirmation of current bindings/secrets.
