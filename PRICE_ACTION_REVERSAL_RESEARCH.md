# Multi-timeframe price-action reversal research (experimental)

This module is deliberately isolated from the production scanner and the demo execution adapter. It is a research primitive, not an approved trading strategy.

## Intended sequence
- M15: structural context (higher-low / lower-high).
- M5: confirmation through a completed-candle rejection, engulfing pattern, break of structure, or false-break reclaim/rejection.
- M1: entry timing evidence (pin bar / hammer / shooting-star geometry, engulfing, local swing structure).

A single M1 hammer/pin bar is never sufficient for a candidate. The module requires a score threshold and M5 confirmation before returning `candidate`. A candidate is still not an order instruction.

## Safety and limitations
- Input arrays must be oldest-to-newest and contain completed candles only. The caller must supply genuine completed candles; `complete:false` is rejected.
- Geometry is normalized against timeframe ATR, not fixed points, to reduce scale dependence across synthetic indices.
- No Deriv API, account, credentials, network, order placement, Telegram alert, production scanner, or PR #32 wiring is included.
- No parameter has been tuned or proven profitable. Scores are heuristic research weights and correlated signals may still double-count evidence.
- Pivot detection is intentionally confirmed only when right-side candles exist, which introduces confirmation delay and avoids look-ahead.
- Volatility 50 and Boom 500 must be evaluated separately; results must not be generalized across synthetic markets.
- The current production collector/scanner does not automatically provide this module with M1/M5/M15 candle arrays. Integration requires a separate verified data pipeline and replay.

## API
`analyzeReversal({ market, m1, m5, m15 }, overrides?)` returns a research state (`none`, `watch`, `candidate`, `conflict`, or `insufficient_data`), directional evidence and context. `executionAllowed` is always `false`.

## Validation before any integration
1. Build a chronological replay set for R_50 and BOOM500, with exact timestamps and no future candles.
2. Compare baseline EMA-only signals with M1 pattern-only, M1+M5 confirmation, and M1/M5/M15 structure variants.
3. Report early-reversal lead time, false positives, missed reversals, SL incidence, MFE/MAE, holding time, and net outcomes after realistic contract pricing/payout.
4. Split by market and by chronological train/validation/holdout periods. Do not tune on the holdout.
5. Keep this module disconnected from demo order execution until results pass independently agreed criteria and the Deriv demo adapter has been authenticated and validated.

## Local test
Run: `node --test test/price_action_reversal.test.js`
