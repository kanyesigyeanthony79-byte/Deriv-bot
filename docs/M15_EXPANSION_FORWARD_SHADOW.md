# RB100 / RB200 M15 forward-shadow validation

## Purpose and isolation

This module tracks the original M15 engine on only RB100 and RB200 after the first forward-observation run. It does not add either market to the production scanner allow-list or production signal journal.

- Uses the existing `engine.evaluate` M15 rules.
- Evaluates completed M15 candles only.
- First run establishes a forward cursor; historical candles are not backfilled as forward observations.
- Entry is the open of the next M15 candle.
- Stop distance is 1.5 × ATR(14), TP1 is a 2R milestone, and TP2 is 3R.
- TP1 does not close a partial position or move the stop.
- Maximum outcome horizon is 96 completed M15 candles.
- Same-candle stop/target touches are ambiguous; missing coverage is censored; no barrier within the horizon is unresolved.
- Four-candle engine cooldown is preserved.
- Signals are sent through the existing research-only Telegram route and labelled `SHADOW / RESEARCH — NOT LIVE`.
- No production alert route, MT5 queue, demo order, or real-money order is used.

## Persistence

The dedicated `m15_expansion_forward_shadow_journal.json` records each forward setup, exact next-candle entry, levels, TP1 milestone, outcome, coverage, gaps, cooldown suppression, and per-market summary. Telegram delivery attempts are deduplicated and retried through the existing research delivery journal.

## Interpretation and promotion

The 180-day replay is discovery evidence, not proof of a tradable edge. Forward observations are kept separate from historical backtest results. Review both markets independently, including signal frequency, resolved expectancy, unresolved/ambiguous/censored rates, drawdown and data continuity. Do not promote based on a small sample; execution costs and realistic fill assumptions require separate validation and approval.

This research stream cannot place trades and does not change Legacy M15.
