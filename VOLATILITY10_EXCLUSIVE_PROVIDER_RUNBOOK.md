# Volatility 10 exclusive provider — deployment and rollback runbook

## Provider identity

- Canonical instrument: `R_10` (Volatility 10 Index)
- Accepted aliases: `R_10`, `Volatility 10 Index`, `Volatility10Index`, `Volatility 10`, `Volatility 10 Index_M1`
- Provider ID / strategy version: `volatility10_ema_atr_slope20_v1`
- Timeframe: M1 completed candles only
- Mode: paper only; this implementation never submits orders

## Default state

The repository configuration is fail-closed:

| Variable | Default | Meaning |
|---|---|---|
| `R10_PAPER_PROVIDER_ENABLED` | `false` | Scanner does not start |
| `R10_PAPER_ROUTE_ENABLED` | `false` | Worker suppresses all R10 alerts |
| `R10_PAPER_TELEGRAM_ENABLED` | `false` | Scanner does not send Telegram |
| `R10_EMERGENCY_KILL_SWITCH` | `true` | Worker blocks paper alerts and scanner stays off |
| `R10_LEGACY_ROLLBACK_ENABLED` | `false` | All legacy R10 providers stay suppressed |

The Cloudflare Worker must be deployed separately. Until its variables are explicitly set, the R10 Telegram route remains closed. R10 is removed from the MT5 allow-list and any old pending R10 queue entries are rejected by the queue consumer.

## Enable paper collection only

After PR review and merge:

1. Deploy `cloudflare/deriv-mtf-watchdog.js` to the existing `deriv-mtf-watchdog` Worker, preserving its existing `GITHUB_TOKEN`, `STATE` KV binding and `EXTERNAL_SCHEDULER_ENABLED` setting. Its existing `* * * * *` Cron Trigger should remain unchanged.
2. Deploy the updated `workers/deriv-telegram-alerts/worker.js` to the existing **Cloudflare `deriv-telegram-alerts` Worker**. Preserve its `EXECUTION_QUEUE` Durable Object namespace binding, existing secrets (`SIGNAL_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `REVIEW_PAGE_URL`, and `MT5_OBSERVATION_ENABLED`), compatibility settings, and existing Durable Object migration. Verify the deployed source contains the exact R10 provider/paper/M1 gate and no longer includes `R_10` in `MT5_ALLOWED_MARKETS`. Do not enable the R10 Telegram route during this deployment step.
3. Set these variables on the **Cloudflare `deriv-mtf-watchdog` Worker**: `R10_PAPER_SCHEDULER_ENABLED=true`, `R10_PAPER_PROVIDER_ENABLED=true`, and `R10_EMERGENCY_KILL_SWITCH=false`. The first enables dispatch; the second and third are independent scheduler safety gates.
4. Set these GitHub repository Actions variables: `R10_PAPER_PROVIDER_ENABLED=true` and `R10_EMERGENCY_KILL_SWITCH=false`. These are checked again by the scanner workflow itself.
5. Keep `R10_PAPER_ROUTE_ENABLED=false` and `R10_EMERGENCY_KILL_SWITCH=true` on the **Cloudflare `deriv-telegram-alerts` Worker** so the notification gateway stays blocked. Keep GitHub `R10_PAPER_TELEGRAM_ENABLED=false`.

The scheduler checks for an already queued/running R10 job before dispatching another, and the scanner polls for 45 seconds per run. GitHub runner startup and queue latency are asynchronous, so this is a one-minute dispatch attempt, not a hard real-time M1 delivery SLA. Late-recovered signals are journaled but not sent as alerts. Keep Telegram paper routing disabled until cadence and forward-paper health are reviewed.

**Additional pre-activation blocker — outage recovery:** the scanner currently does not explicitly invalidate an open paper position when the first candle in the fetched 1,200-candle history is more than 60 seconds after the persisted `lastProcessedEpoch`. A long outage can therefore make an old position appear to continue across missing M1 candles. Before enabling `R10_PAPER_PROVIDER_ENABLED`, fix this path so the position is recorded as unresolved (`DATA_GAP`), indicator warm-up restarts, and automated tests cover both gaps inside the fetched history and gaps longer than the 1,200-candle window.

## Enable paper Telegram alerts

Only after the scanner's candle cadence, paper journal, exits, and health have been reviewed:

1. On the `deriv-telegram-alerts` Worker, set `R10_PAPER_ROUTE_ENABLED=true` and `R10_EMERGENCY_KILL_SWITCH=false`.
2. On GitHub Actions, set `R10_PAPER_TELEGRAM_ENABLED=true` only if Telegram paper alerts are desired. Keep `R10_PAPER_PROVIDER_ENABLED=true` and the GitHub `R10_EMERGENCY_KILL_SWITCH=false`.

The Worker accepts an R10 alert only if its provider ID and strategy version match, timeframe is M1, status is PAPER, and `live !== true`. All other R10 signals and outcomes are suppressed.

Keep `MT5_EXECUTION_ENABLED=false`. Do not enable any live order execution.

## Emergency kill switch

Immediately set `R10_EMERGENCY_KILL_SWITCH=true` on both Cloudflare Workers (`deriv-mtf-watchdog` and `deriv-telegram-alerts`) and in GitHub Actions. Also set `R10_PAPER_PROVIDER_ENABLED=false` in both the watchdog Worker and GitHub Actions, and set `R10_PAPER_SCHEDULER_ENABLED=false` on the watchdog. The Telegram Worker blocks R10 notifications independently of the scanner.

## Roll back to the previous R10 signal providers

Set `R10_LEGACY_ROLLBACK_ENABLED=true` in:
- GitHub repository Actions variables
- Cloudflare Worker variables

This re-enables the legacy hosted scanner, MTF signal providers and their prior R10 Telegram routing. It does **not** restore R10 MT5 execution; the R10 MT5 allow-list remains disabled intentionally. To restore the complete pre-change source tree, revert this PR after first setting the emergency kill switch.

## Strategy and exit rules

- EMA(12), EMA(26), EMA(100), Wilder ATR(14), trailing 1,000-value ATR median.
- Long/short EMA12/26 cross on the completed candle, close on the correct side of EMA100, all three EMAs sloping in the same direction versus 20 completed bars earlier, ATR >= rolling median.
- Reference entry is the next M1 candle open.
- Stop and target are each 3.0 x ATR(14) measured on the signal candle.
- Opposite EMA cross exits only after three completed position candles.
- Stop is resolved before target if both are touched in one candle.
- One active paper position; duplicate signal candle blocked.
- Data gaps reset the indicator warm-up; signals are not evaluated across a gap.

## Validation status at PR creation

- Stage 52 historical replay completed on 1,030,265 candles from 2024-12-01 to 2026-11-16.
- Later chronological validation: 438 resolved trades, 40.87% win rate, 1.0430 profit factor, +7.204R.
- Full replay: 1,498 resolved trades, 38.25% win rate, 0.9285 profit factor, -43.214R.
- Commission excluded; spread and 0.01 price-unit adverse slippage per side included.
- Later-period validation is not a pristine untouched holdout.
- Node tests: 38/38 passed in the latest completed Hosted Scanner Journal Tests run.
- Forward paper validation has **not** yet been run. Provider and route flags remain off by default. Do not activate paper Telegram routing until forward validation and health checks pass.
