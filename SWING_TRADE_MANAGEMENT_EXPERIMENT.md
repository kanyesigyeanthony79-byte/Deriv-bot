# Experimental synthetic swing trade management

This module is a read-only advisory prototype for managing an already-open synthetic-index swing position. It is deliberately separate from the live scanner, Telegram router and order execution.

## Intended workflow

- M5: monitor each newly completed candle for barriers and developing changes.
- M15/H1: confirm or reject lower-timeframe deterioration.
- H4/D1: decide whether the larger swing thesis remains aligned.
- Recommendations: HOLD, WATCH_CLOSELY, MOVE_TO_BREAK_EVEN, PARTIAL_PROFIT, TRAIL_PROTECT_PROFIT, EXIT_EARLY, CLOSE_REMAINDER, EXIT_AT_SL, WAIT_FOR_DATA or AMBIGUOUS_BARRIER.

## Initial test thresholds (not validated settings)

- Break-even consideration at +1R.
- TP1 partial-profit advice when the original TP1 is touched.
- M15-structure trailing considered after +1.5R and only after a partial is recorded.
- Early exit on a losing position when H1 and M15 both oppose it; a profitable runner is not closed solely for a lower-timeframe reversal.
- A profitable runner is closed early when both H4 and D1 oppose the position. When a partial has been taken, lower-timeframe weakness may justify a profit-protecting M15-structure trail, but only if the proposed stop is beyond entry.
- Missing candles and same-candle barrier ambiguity suppress confident advice.

These are hypotheses for historical replay, not recommended live settings. The paired historical validator now replays the complete position lifecycle for both baseline and refined swing entries. It assumes a 50% partial close when partial-profit advice is triggered, then evaluates the remaining position. That fraction is a modelling assumption, not a user setting or execution instruction.

The lifecycle replay compares the managed approach against a fixed TP1/TP2 benchmark: take the same assumed 50% partial at TP1, leave the remaining half at the original stop, and close it at TP2 or the seven-day horizon. Both approaches use the same signal, entry candle and future price path. It reports realized R, profit factor, win rate, average and longest winning hold, early exits, break-even exits, trailing-stop exits, TP2 exits, ambiguous barriers and data-unavailable cases. It uses only candles completed by each M5 decision point and limits indicator inputs to recent continuous history. No fees, spread, slippage or rejected-order model is yet included. Results must be reviewed by market and then checked on chronological out-of-sample periods. Thresholds must be tested per index rather than assumed universal. The first replay exposed premature profitable exits on Jump 100 when H1/M15 reversed while H4/D1 remained aligned. The next experiment therefore separates losing-trade early exits from profitable-runner protection: lower-timeframe reversal alone no longer closes a winner, and any new trailing stop must lock in price profit beyond entry.

No stop-loss is moved, no position is closed, no order is placed, and no live alert is enabled by this module.

## New diagnostic layer (retrospective, not a trading rule)

The paired replay now attaches a path-diagnostic record to each fixed-plan and managed lifecycle result. It measures maximum favourable excursion (MFE), maximum adverse excursion (MAE), bars until +1R, and peak-to-exit giveback in R. For a manager-triggered early exit, it also inspects the remaining historical path to report whether the original TP1, TP2 or stop would later have been touched, plus the observed post-exit MFE/MAE and whether the full seven-day horizon was available.

These are retrospective counterfactual measurements only. They are not available to the live decision at the time of exit and must never be fed into the manager as predictive inputs. A later target touch does not by itself prove that holding was preferable: the trade might first have crossed its original stop, and OHLC candles cannot establish intrabar ordering when barriers are touched in the same candle. The diagnostic output is descriptive and must be interpreted alongside the actual exit path, ambiguity, missing-history coverage and market-specific sample size.

The next review should compare per-market MFE/MAE, time-to-1R, giveback, early-exit counterfactuals and realised R before changing any management thresholds. Costs, spread, slippage and execution failures remain unmodelled.
