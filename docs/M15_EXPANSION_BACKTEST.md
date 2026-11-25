# M15 Expansion Backtest

## Purpose and isolation

This is a paper-only historical replay for the seven proposed expansion markets:

- R_100
- JD25
- JD50
- RB100
- RB200
- BOOM100
- CRASH100

It reuses the existing M15 `engine.evaluate` logic. It does not enable these markets in the production scanner, call Telegram, place orders, or modify the production trade journal.

## Run locally

Requires Node.js 22 or newer (the public Deriv WebSocket client uses the runtime's global `WebSocket`).

```sh
npm test
npm run backtest:m15-expansion -- --days=180 --output=artifacts/m15_expansion_backtest_report.json
```

Use explicit epoch boundaries when reproducing a particular period:

```sh
npm run backtest:m15-expansion -- --start=1790000000 --end=1795000000 --output=artifacts/replay.json
```

## Run from GitHub Actions

Open **Actions → M15 Expansion Backtest → Run workflow**, choose the historical window in days, and start the manual run. The JSON report is uploaded as a workflow artifact for 90 days.

This workflow is manual only. It is not scheduled and has no Telegram or production-scanner integration.

## Replay assumptions

- Signal evaluated on a completed M15 candle.
- Entry at the next M15 candle open.
- Stop distance is 1.5 × ATR(14).
- TP1 is a 2R milestone only; it does not book partial profit or move the stop.
- TP2 is 3R.
- Maximum outcome horizon is 96 M15 candles (24 hours).
- Ambiguous same-candle stop/target touches are not forced into wins or losses.
- The currently forming candle is excluded.
- Missing candles split the history into separate continuous replay segments.

The report records the SHA-256 of `engine.js`, per-market candle coverage, gaps, and unresolved/ambiguous outcomes. Review each market's `dataQuality.coveragePct` before interpreting its performance. The combined R figure is a simple research outcome sum, not a portfolio simulation or actual account P/L.

## Important limitations

This is historical counterfactual evidence, not proof of a tradable edge. It does not model execution latency, spread, slippage, contract payout changes, partial exits, or real account sizing. TP1 is deliberately a milestone rather than a simulated partial close. Any change to the live engine changes the strategy hash and should trigger a new separately identified research run.
