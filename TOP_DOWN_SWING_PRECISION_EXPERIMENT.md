# Top-Down Swing Discovery + Precision Entry Experiment

## Status and isolation

This is a separate, read-only research candidate. It is not the existing `SWING` category in `multi_timeframe_engine.js`, and it is not PR #15's staged reversal/sniper experiment. PR #15 remains an independent benchmark and must not be modified by this work.

The candidate must not connect to the production scanner, Telegram delivery, order placement, or automatic stop management. No live alerts, trades, or stop changes are enabled by this experiment.

## Research question

Can a top-down swing setup identified on higher timeframes, then refined on lower timeframes, produce better risk placement and trade management than the current baseline without simply overfitting to tiny stops?

The intended opportunity is a longer swing on Deriv synthetic indices. The lower timeframe is for entry precision; it must not redefine the higher-timeframe thesis.

## Timeframe responsibilities

| Timeframe | Responsibility | Required output |
| --- | --- | --- |
| D1 | Broad market structure and major directional context | bullish, bearish, neutral; key completed swing levels; context invalidation |
| H4 | Main swing discovery and setup validation | continuation/reversal candidate, structural trigger, invalidation, room to target |
| H1 | Setup refinement | pullback/continuation structure and confirmation state |
| M15 | Entry refinement | local pullback, rejection/reclaim or structure break |
| M5 | Optional precision trigger | local confirmation after M15 setup; never a standalone directional thesis |

D1 is context, not an unconditional veto: the experiment should separately measure aligned-with-D1 and counter-D1 early-reversal cases. H4 defines the main swing thesis. H1 confirms it. M15/M5 refine entry.

## Candidate variants to compare

All variants must use the same markets, historical date range, candle snapshots, fees/payout assumptions where applicable, and outcome horizon.

1. **H1 control:** H4 swing + H1 confirmation, with no M15/M5 trigger.
2. **M15 refinement:** same H4/H1 thesis, entry only after completed M15 refinement.
3. **M15 + M5 refinement:** same thesis, M15 setup followed by completed M5 trigger.

The comparison must retain the same higher-timeframe setup definition. It must not compare different swing populations and then attribute the difference to entry precision.

## Entry and risk principles

- Use completed candles only. Every timeframe input for a historical decision must have closed by that decision timestamp.
- No future candles, repainting pivots, or hindsight-confirmed swing points may be used before their confirmation time.
- Record the H4 structural invalidation level and the proposed entry before calculating risk.
- Compare structural stops with volatility buffers against an ATR-only reference. Do not assume the narrowest stop is best.
- Reject entries whose stop is inside ordinary local noise or whose stop distance exceeds a predeclared risk ceiling.
- Store stop distance in price units and normalized ATR/R units so markets can be compared.
- Avoid hard-coded assumptions that synthetic indices behave like conventional order-book markets.

## Trade-management experiments

For each accepted entry, replay at least these policies independently:

- Fixed reference exits (baseline).
- Partial profit at TP1, then protect the remainder using a rule fixed before replay.
- Structure-aware management: hold while H1/H4 swing structure remains valid; record early-exit warnings on completed-candle momentum/structure deterioration; move protection only after a predeclared favourable-R threshold.
- Early loss exit: test only objective, completed-candle invalidation signals and compare against holding to the original stop.

A recommendation to take profit early, move to break-even, trail, or exit a loser must be logged as an advisory event with timestamp, reason, and price. A stop must never be silently changed in the live system.

## Required outcome metrics

Report by market, direction, timeframe variant, and management policy:

- number of eligible setups, rejected setups and actual entries;
- average and median initial stop distance (price, ATR and R);
- stop-loss rate and ambiguous/same-candle outcomes;
- TP1 and TP2 hit rates;
- net and average realised R, including partial exits;
- maximum favourable excursion (MFE) and maximum adverse excursion (MAE);
- holding time and percentage of trades reaching each duration bucket;
- frequency and result of early-profit, break-even, trailing and early-loss advisories;
- missed-move rate and false-exit rate;
- data gaps, insufficient history and excluded cases.

Show sample sizes and uncertainty. Do not label a variant improved on a small sample or on win rate alone. Compare distributions and downside as well as average return.

## Validation gates

1. Unit tests for candle validation, pivot confirmation timing, timeframe cutoffs, entry triggers, invalidation and management events.
2. A deterministic fixture replay with hand-checkable expected events.
3. Historical replay on identical saved candle snapshots for every variant.
4. A separate out-of-sample period not used to tune thresholds.
5. Market-by-market results; no pooling that hides a failing index.
6. Confirm that the same signal cannot be emitted twice and that missing candles suppress rather than fabricate a setup.

If historical snapshots do not contain enough D1/H4/H1/M15/M5 history, report that limitation and acquire/save the required data before claiming validation. Do not fabricate results.

## Implementation sequence

1. Implement a pure analysis module in this branch only, with explicit timestamp cutoffs and no network or execution dependencies.
2. Add deterministic unit tests for the higher-timeframe thesis and lower-timeframe entry variants.
3. Reuse or adapt the existing historical replay infrastructure only after verifying its data format and look-ahead protections.
4. Generate a comparative report against the H1 control and, separately, PR #15's staged reversal/sniper experiment.
5. Keep this pull request in draft until code, tests and historical evidence are available.

## Non-goals

- No automatic trading or order placement.
- No automatic stop-loss changes.
- No production scanner/dashboard/Telegram integration.
- No claim that synthetic indices are predictable or that any setup guarantees profit.
- No merging or activation based only on a promising backtest.


## Implementation progress — 2026-11-14

- Added `top_down_swing_engine.js`: confirmed D1/H4/H1 structure, three comparable entry variants (H1 control, M15 refinement, M15+M5 refinement), H4 structural invalidation with ATR buffer/risk ceiling, and advisory-only hold/break-even/trailing/partial-profit/structure-deterioration/early-loss events.
- All timeframe inputs are re-cut at the candidate entry candle close. Pivots are not available until their right-hand confirmation candles have closed.
- Added `top_down_swing_replay.js`: seven-day forward outcomes, fixed-exit and 50%-at-TP1 comparison, MFE/MAE, censored-window handling, and ambiguous same-candle handling. No spread, slippage or fees are modelled; reports must disclose this.
- Added deterministic tests and a dedicated GitHub Actions workflow. Latest run: 10/10 experiment tests passed; syntax checks passed for the engine, backfill and replay scripts. Existing multi-timeframe tests also passed.
- Added `top_down_swing_backfill.js` and a manual-only workflow to request longer M5/M15/H1/H4/D1 OHLC history and upload it as a research artifact. It does not change the production collector or send alerts.

### Data limitation and next gate

The latest existing observation artifact (2026-11-14 13:55 UTC) contains 239 M5 candles per synthetic market (about 20 hours), 239 M15 candles (about 2.5 days), 239 H1 candles (about 10 days), 239 H4 candles (about 40 days), and 365 D1 candles. That snapshot is not long enough to score a seven-day holding horizon with adequate independent entries. The manual backfill workflow must be run and its artifact inspected before the comparative historical replay can be treated as evidence. Until then, no claim of improved performance is justified.
