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

After PR review and merge, set GitHub repository Actions variables:

1. `R10_PAPER_PROVIDER_ENABLED=true`
2. Keep `R10_EMERGENCY_KILL_SWITCH=true` while validating collection without alerts.

The scanner warms up on 1,050+ completed M1 candles and then records each newly completed bar it can recover. The GitHub Actions schedule is every five minutes with a short polling loop; it is not a hard real-time scheduler. Late-recovered signals are journaled but not sent as alerts. Do not treat this as a production-grade one-minute delivery SLA.

## Enable paper Telegram alerts

Only after the scanner's candle cadence, paper journal, exits, and health have been reviewed:

1. Set the Cloudflare Worker variable `R10_PAPER_ROUTE_ENABLED=true`.
2. Set the Cloudflare Worker variable `R10_EMERGENCY_KILL_SWITCH=false`.
3. Set the GitHub Actions variable `R10_EMERGENCY_KILL_SWITCH=false`.
4. Set `R10_PAPER_TELEGRAM_ENABLED=true` only if Telegram paper alerts are desired.

The Worker accepts an R10 alert only if its provider ID and strategy version match, timeframe is M1, status is PAPER, and `live !== true`. All other R10 signals and outcomes are suppressed.

Keep `MT5_EXECUTION_ENABLED=false`. Do not enable any live order execution.

## Emergency kill switch

Immediately set both:
- Cloudflare Worker variable `R10_EMERGENCY_KILL_SWITCH=true`
- GitHub Actions variable `R10_EMERGENCY_KILL_SWITCH=true`

Also set `R10_PAPER_PROVIDER_ENABLED=false` to stop the scanner at its next start. The Worker blocks the R10 notification route independently of the scanner.

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
