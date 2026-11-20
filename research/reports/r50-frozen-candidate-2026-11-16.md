# R_50 Archived Replay — Reproducible Harness Results

**Run date:** 16 November 2026  
**Workflow:** R_50 Research Replay  
**GitHub Actions run:** https://github.com/kanyesigyeanthony79-byte/Deriv-bot/actions/runs/43833414264  
**Status:** Research only; not approved for production or trading

## Dataset

- Market: R_50
- Timeframe: M15
- Candles: 1,080
- First candle: 2026-11-05 01:45 UTC
- Last candle: 2026-11-16 07:30 UTC
- Continuity: every interval is exactly 900 seconds; no gaps or duplicates
- Chronological split: 648 discovery candles (60%), 432 holdout candles (40%)

The replay is now reproducible through `scripts/r50_replay.js`. CI executes the unit tests, runs the full archived R_50 replay, generates a JSON report, and uploads that report as the `r50-replay-report` workflow artifact.

## Frozen candidate — selected without looking at holdout

The script freezes the highest discovery-expectancy candidate that meets the minimum 15 resolved discovery-trade requirement. The parameters are locked for future unseen-data evaluation:

| Parameter | Frozen value |
|---|---:|
| Direction | EMA20/EMA50 trend; close on trend side of EMA20 |
| Pullback | Touch EMA20 zone within 0.25 ATR and close back in trend direction |
| Candle body | Directional body at least 50% of candle range |
| RSI | RSI(14): BUY 55–72; SELL 28–45 |
| Stop | 1.25 × ATR(14) |
| Target | 1.5R |
| Entry | Next M15 candle open |
| Maximum hold | 16 M15 bars (4 hours) |
| Signal spacing | At least 4 bars |

### Results

| Sample | Signals | Resolved | Wins | Losses | Win rate | Expectancy |
|---|---:|---:|---:|---:|---:|---:|
| Discovery | 27 | 25 | 15 | 10 | 60.0% | +0.500R |
| Holdout | 14 | 14 | 7 | 7 | 50.0% | +0.250R |

**Decision: does not pass the greater-than-50% holdout threshold.** The candidate is frozen for prospective testing only; it is not a qualified strategy. Fourteen holdout trades are also far too few for a reliable estimate.

## Baseline comparison

EMA20/EMA50 context baseline with 1.5 ATR stop and 2R target:

| Sample | Signals | Resolved | Wins | Losses | Time exits | Win rate | Expectancy |
|---|---:|---:|---:|---:|---:|---:|---:|
| Discovery | 128 | 96 | 40 | 56 | 32 | 41.7% | +0.250R |
| Holdout | 82 | 63 | 24 | 39 | 19 | 38.1% | +0.143R |

The filtered candidate reduces signal frequency substantially and improves the observed hit rate relative to this baseline, but it has not demonstrated a greater-than-50% holdout win rate.

## Important anti-selection-bias note

Other configurations in the candidate grid show higher holdout percentages. For example, the same entry filters with a 1.25R target recorded 9 wins from 14 holdout trades (64.3%). **We must not switch to that setting because of its holdout result.** It was not the top discovery-ranked configuration, and choosing it after inspecting holdout outcomes would turn the holdout into another tuning set.

The frozen candidate remains the discovery-selected 1.5R configuration. No further parameter changes should be made using this holdout.

## Methodology and limitations

- Completed M15 signal candle; entry at next candle open.
- ATR(14) stop and fixed R target.
- Stop or target touched on the same candle is marked ambiguous and excluded from resolved win-rate denominator.
- Time exits are reported separately and excluded from resolved win-rate denominator.
- Expectancy is calculated only over resolved wins/losses.
- No spread, commission, slippage, rejected fills or execution latency.
- OHLC bars cannot establish the exact intrabar sequence when both stop and target are touched.
- This is one historical capture window. The holdout is small and may not represent different market regimes.
- M1/M5 entry timing is not validated by this M15 replay.

## Next stage

1. Do not alter the frozen parameters.
2. Collect fresh public Deriv M15 candles after 2026-11-16 07:30 UTC.
3. Evaluate only the frozen configuration on candles not used in discovery or holdout.
4. Keep shadow results separate from historical replay and from the current production strategy.
5. Reassess only after a materially larger sample and after costs/realistic execution assumptions are included.

No production signals were changed, no Telegram alerts were enabled by this research, and no trading/account actions were performed.
