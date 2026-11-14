# Experimental market-structure layer (not activated)

## Purpose
Add structure context to the existing EMA/RSI/ATR signal logic without changing production alerts or enabling orders.

## Proposed analysis
- Confirm swing highs/lows only after the configured right-hand candles have closed; never use a pivot before it is confirmed.
- Classify structure from the last two confirmed swing highs and lows: HH+HL = bullish, LH+LL = bearish, otherwise mixed/ranging.
- Detect bullish/bearish break of structure (BOS) only on a completed candle close beyond the last confirmed swing level.
- Detect change of character (CHoCH) when a completed close breaks the opposing protected swing against the previously established structure bias.
- Use H1/H4 for context, M15 for setup, and M5/M1 only for entry refinement. A missing or incomplete timeframe must return UNKNOWN, never be filled with fabricated candles.
- Combine with the existing EMA20/EMA50 trend, RSI14 momentum, ATR14 volatility, candle quality, and extension checks as independent evidence.

## Trade-management research
Track structure validity after entry, adverse/favourable excursion, time in trade, momentum deterioration, and confirmed opposing CHoCH. Evaluate partial-profit, break-even, trailing, and early-exit rules independently in replay before recommending them.

## Validation gates
1. Unit tests for pivots, BOS, CHoCH, equal highs/lows, insufficient history, and incomplete candles.
2. Chronological replay with no look-ahead; compare baseline vs combined strategy on identical data.
3. Report per-market trade count, expectancy, win rate, maximum drawdown, MAE/MFE, holding time, early exits, break-even outcomes, and stop-loss outcomes.
4. Forward demo observation on unseen data before any activation decision.

## Safety
This is a research specification only. It does not change engine.evaluate, the existing scanner, Telegram production alerts, trade settings, or account permissions. No automatic execution or stop changes are enabled.
