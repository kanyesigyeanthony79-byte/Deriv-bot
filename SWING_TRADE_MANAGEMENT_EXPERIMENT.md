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
- Early exit only when H1 and M15 both oppose the position, or H4 and D1 both oppose it.
- Missing candles and same-candle barrier ambiguity suppress confident advice.

These are hypotheses for historical replay, not recommended live settings. The paired historical validator now replays the complete position lifecycle for both baseline and refined swing entries. It assumes a 50% partial close when partial-profit advice is triggered, then evaluates the remaining position. That fraction is a modelling assumption, not a user setting or execution instruction.

The lifecycle replay compares managed outcomes against the existing fixed SL/TP outcome labels and reports realized R, holding time, early exits, break-even exits, trailing-stop exits, TP2 exits, ambiguous barriers and data-unavailable cases. It uses only candles completed by each M5 decision point and limits indicator inputs to recent continuous history. No fees, spread, slippage or rejected-order model is yet included. Results must be reviewed by market and then checked on chronological out-of-sample periods. Thresholds must be tested per index rather than assumed universal.

No stop-loss is moved, no position is closed, no order is placed, and no live alert is enabled by this module.
