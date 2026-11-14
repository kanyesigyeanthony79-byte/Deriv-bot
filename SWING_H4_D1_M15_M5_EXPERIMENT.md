# Experimental H4/D1 swing with lower-timeframe entry refinement

This is a development-only, read-only candidate. It is not imported by the live scanner,
Telegram worker, or order execution code.

## Decision sequence

1. **D1 + H4:** both must show the same non-neutral directional bias.
2. **H1:** the existing trend/swing setup evaluator must produce a valid setup in that direction.
3. **M15:** a completed pullback/rejection candle must confirm the setup.
4. **M5:** the existing entry evaluator must independently trigger in the same direction.
5. **Risk:** stop distance is based on H4 ATR (1.75 ATR); targets are 1.5R and 2.5R.

All higher-timeframe candles are filtered to those fully completed by the M5 entry candle close.
If any required timeframe is warming, conflicted, or has a data gap, the candidate withholds
the signal. M5 cannot override H4/D1/H1/M15.

## Evaluation plan

Run the existing M5 swing rules and this candidate against the same completed candle snapshot.
Use the same seven-day forward outcome window, four-entry-bar cooldown, and conservative
same-candle SL/TP ambiguity handling. Report signal counts, overlap, stop-before-TP1,
stop-after-TP1, TP1-only, TP2, ambiguous outcomes, and per-market coverage.

Gold is explicitly deferred until the separately agreed Monday review. Historical outcomes
are descriptive, not evidence of profitability; there is no fees/slippage or portfolio model.
No live alerts, automatic trades, or stop-loss changes are enabled.
