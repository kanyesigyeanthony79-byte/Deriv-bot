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

These are hypotheses for historical replay, not recommended live settings. The next stage must replay complete position lifecycles on synthetic indices, compare against fixed SL/TP management, include costs/spread assumptions where available, and use chronological out-of-sample periods. Thresholds must be tested per index rather than assumed universal.

No stop-loss is moved, no position is closed, no order is placed, and no live alert is enabled by this module.
