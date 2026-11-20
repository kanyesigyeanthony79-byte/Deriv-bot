# MTF Performance Investigation — 2026-11-18

**Status:** Initial code/data audit; no production logic changed  
**Repository baseline:** `main`  
**Working branch:** `research/mtf-performance-audit-2026-11-18`  
**Trading safety:** Signal-only / shadow research. Automatic trading remains disabled.

## 1. Scope and population definitions

The supplied 2026-11-18 daily report describes all MTF observation signals generated on that Uganda calendar day:

| Measure | Count |
|---|---:|
| Generated | 56 |
| Telegram sent | 20 |
| Delivery failed | 3 |
| Delivery status untracked | 33 |
| TP2 | 0 |
| Stop loss | 14 |
| Expired | 24 |
| Unresolved | 18 |
| TP1 reached | 2 |

These 56 generated observations must not be conflated with the saved strategy-version performance report, which uses **Telegram-delivered journal signals across the full retained history**.

The saved report generated at 2026-11-19 09:32 UTC contains 175 delivered signals overall. The MTF_BASELINE_V1 subset contains 88 delivered signals: 2 TP2, 16 stopped, 56 expired, and 14 pending. Its decisive TP2 rate is 11.1% (2 / (2 + 16)); 70 of 88 records are excluded from that decisive rate. This is a historical descriptive statistic, not a probability forecast or realized account return.

## 2. Initial findings

### A. Daily MTF result is weak, but not fully resolved

The daily sample has 14 stop outcomes and no TP2 wins. However, 18 signals were still unresolved and 24 expired. The decisive win-rate denominator is therefore only the resolved win/loss population, not all 56 generated signals. The report's 0% resolved win rate is a warning, not a complete strategy verdict.

### B. Expiry is a major contributor

24 / 56 generated observations expired (42.9%). The next investigation should separate expiry records by:
- category and market;
- elapsed time to expiry;
- maximum favourable excursion divided by initial risk (MFE/R);
- whether TP1 was touched before expiry;
- whether the signal was delivered or not;
- latest continuous candle-data coverage.

MFE is not an executable result. A later favourable candle does not establish that TP was reached before SL or before the signal's expiry deadline.

### C. Gold is a high-volume problem area

The supplied daily report shows 22 Gold/USD observations: 5 stopped, 11 expired, 6 unresolved, and 0 TP2. The three largest listed Gold SELL MFE observations were +27.27, +25.95, and +23.57 points. These are excursions only and do not establish target-before-stop order.

Gold should be analysed separately by category, direction, entry timeframe, and data continuity. Do not simply loosen filters or increase Gold signal volume.

### D. Delivery telemetry is incomplete

Only 20 of 56 MTF observations have confirmed Telegram delivery, 3 are marked failed, and 33 are untracked. Strategy quality and delivery quality are separate workstreams. Delivery status must be measured before conclusions are drawn about user-visible signal coverage.

## 3. Outcome-review consistency issue found in code audit

The current advisory reviewer in `signal_review.js`:
1. selects all available completed entry-timeframe candles after the original signal candle;
2. scans forward for the first stop/target touch in that available candle array;
3. does not constrain that scan to the journal's recorded terminal timestamp or the signal's intended expiry deadline.

The collector invokes this reviewer for delivered signals, including records already marked terminal or expired. Consequently, the reviewer can report a later stop/target touch after the journal outcome was already fixed, or after the observation should have expired. The rolling candle history can also omit earlier candles for older signals.

The saved performance report's advisory comparison includes examples of these disagreements:
- 6 journal-stopped records currently reviewed as TP2-level touched;
- 6 journal-TP2 records currently reviewed as stop-level touched;
- 27 expired records currently reviewed as TP2-level touched;
- 32 expired records currently reviewed as stop-level touched.

These are **not proof that the journal outcomes are wrong**. They demonstrate that the current advisory review is not a like-for-like reconciliation of the original outcome window. The review is a later candle-level observation and must not be treated as a correction to the journal.

## 4. Recommended repair sequence

1. Preserve the current production journal and strategy parameters as immutable evidence.
2. Change the audit/review semantics in an isolated branch so terminal journal outcomes are displayed as recorded outcomes, not replayed as if still active.
3. For expired records, stop outcome reconciliation at the intended expiry epoch. If the historical expiry boundary is missing, label the record non-comparable rather than inventing a boundary.
4. For active records only, evaluate completed candles from after entry through the latest valid completed candle, preserving same-candle stop/target ambiguity.
5. Add regression tests for: post-stop later TP, post-TP later stop, post-expiry later target, missing expiry metadata, truncated candle history, and same-candle stop/target.
6. Rebuild the report and compare only records evaluated over the same observation window.
7. Separately investigate the 14 daily stop outcomes, 24 expiries, and 22 Gold signals by record ID and category before considering any strategy parameter changes.

## 5. Guardrails

- Do not edit the legacy 15-minute scanner or journal.
- Do not change MTF entry, stop, target, category, or expiry parameters during this audit.
- Do not enable automatic execution or MT5 queueing.
- Do not promote a candidate strategy based on MFE, a small sample, or an advisory review.
- Keep theoretical candle outcomes separate from broker fills, costs, and realized account P/L.

## 6. Current conclusion

The daily report indicates poor MTF baseline outcomes and weak delivery observability. The code audit also identifies a review-window mismatch that can make later candle touches appear to contradict historical journal outcomes. Therefore, the correct next step is to repair the outcome-review comparison and produce a same-window audit before changing strategy rules.
