# Swing reversal-to-sniper entry experiment

This is a separate, development-only, read-only entry experiment. It is not imported by the live scanner, Telegram router or order execution. The existing swing and trade-management prototypes remain unchanged.

## Staged design

1. **H4 reversal watch:** find a completed close beyond the preceding 10-bar structural range, within the latest three H4 bars, and require that direction to oppose the EMA20/EMA50 trend before the breakout.
2. **H1 confirmation:** require an independent completed structural break in the same direction within the latest two H1 bars.
3. **M15 pullback:** require a controlled pullback around EMA20 followed by a directional close.
4. **M5 sniper trigger:** require a completed close beyond the preceding five-bar local range with a non-trivial body and without an oversized candle.
5. **Risk gate:** place the proposed stop beyond recent M15 structure with an ATR buffer; reject if the stop is invalid or wider than two H4 ATR. Targets are experimental 1.5R and 2.5R.

D1 is reported as context rather than a hard directional veto, because a genuine reversal can begin against the old daily trend. It must not be interpreted as a prediction or a requirement to reverse immediately. Every higher-timeframe input is cut off at the M5 candle close to prevent look-ahead.

## States

- `reversal_watch`: no fresh H4 structural reversal yet.
- `reversal_confirming`: H4 reversal detected; H1 confirmation missing.
- `pullback_wait`: H4 and H1 agree; M15 pullback missing.
- `entry_armed`: M15 setup complete; M5 trigger missing.
- `invalid_risk`: proposed structural stop is invalid or too wide.
- `signal`: all stages completed.
- `warming`: required completed history is unavailable.

## Validation plan

Run this candidate against the same historical candle snapshots as the existing baseline and refined entry, with the same seven-day horizon and conservative same-candle barrier handling. Compare signal count, unique additional entries, stop-before-TP1, TP1/TP2, realised R, MFE/MAE, holding time, per-market results and data coverage. Add realistic costs/slippage and chronological out-of-sample testing before any decision. Do not tune thresholds on the final holdout.

This experiment is a hypothesis, not a profitable strategy claim. Synthetic indices can exhibit abrupt jumps and reversals; candle OHLC cannot establish intrabar barrier ordering. No live alerts, orders, stop changes or automatic execution are enabled.
