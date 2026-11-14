# M15 Context Screen — 14 November 2026

## Status

Research-only descriptive screen. This is **not** a validated trading strategy, and it does not authorize live trading, automated execution, or production alert changes.

Source artifact: GitHub Actions run [#43638997724](https://github.com/kanyesigyeanthony79-byte/Deriv-bot/actions/runs/43638997724), artifact `reversal-candles-43638997724`.

Capture window: 2026-10-31 20:45 UTC through 2026-11-14 20:15 UTC. Each of the seven requested synthetic markets has 1,343 complete M15 candles.

## Capture coverage

| Market | M1 | M5 | M15 |
|---|---:|---:|---:|
| R_10 | 20,145 / 20,159 | 4,030 / 4,031 | 1,343 / 1,343 |
| R_25 | 20,151 / 20,159 | 4,030 / 4,031 | 1,343 / 1,343 |
| R_50 | 20,152 / 20,160 | 4,030 / 4,031 | 1,343 / 1,343 |
| R_75 | 20,152 / 20,160 | 4,030 / 4,031 | 1,343 / 1,343 |
| JD100 | 20,154 / 20,159 | 4,031 / 4,031 | 1,343 / 1,343 |
| CRASH500 | 20,152 / 20,160 | 4,030 / 4,031 | 1,343 / 1,343 |
| BOOM500 | 20,152 / 20,160 | 4,030 / 4,031 | 1,343 / 1,343 |

M15 is complete for all seven markets. M1 and most M5 frames contain missing intervals and are not eligible for the full entry/exit replay. Partial frames are retained for diagnosis only.

## M15 context method

A simple causal context filter was screened:
- Long context when EMA20 > EMA50 and the completed M15 close is above EMA20.
- Short context when EMA20 < EMA50 and the completed M15 close is below EMA20.
- At each eligible completed bar, measure the signed close-to-close movement 16 M15 bars later (four hours), divided by the ATR(14) available at the signal bar.
- The sample is split chronologically into two halves as a basic stability check.

Every eligible bar is sampled, so observations overlap and are not independent. The screen does not model trade entry price, stop loss, take profit, early exit, slippage, payout, contract pricing, or fees. The calculation is reproducible with `node scripts/analyze_m15_context.js research/data` after extracting the capture artifact into `research/data`.

## Results

| Market | Full n | Full median / positive | First half n; median / positive | Second half n; median / positive |
|---|---:|---:|---:|---:|
| R_10 | 866 | -0.17 ATR / 47.1% | 389; -0.16 / 48.6% | 452; -0.37 / 44.2% |
| R_25 | 850 | +0.08 ATR / 51.8% | 412; +0.18 / 52.9% | 417; -0.04 / 49.4% |
| R_50 | 950 | +0.92 ATR / 62.9% | 433; +0.80 / 61.0% | 486; +0.90 / 62.3% |
| R_75 | 863 | -0.16 ATR / 48.4% | 403; +0.15 / 53.1% | 435; -0.40 / 43.7% |
| JD100 | 928 | +0.64 ATR / 59.7% | 426; +0.85 / 61.7% | 481; +0.58 / 59.3% |
| CRASH500 | 844 | -0.59 ATR / 41.4% | 385; -0.75 / 36.6% | 437; -0.39 / 45.5% |
| BOOM500 | 846 | -0.06 ATR / 48.9% | 389; -0.25 / 45.0% | 442; +0.36 / 53.8% |

## Interpretation

1. **R_50 and JD100 are the strongest candidates for deeper research.** Their M15 context screen remained positive in both chronological halves. This is a prioritization signal only, not evidence of profitability.
2. **R_25 is near neutral.** Its small positive full-sample result did not persist in the second half.
3. **R_10 and R_75 are weak or unstable** under this simple context filter.
4. **CRASH500 was negative in both halves** in this particular screen.
5. **BOOM500 changed sign between halves**, so the aggregate result is not stable.

No market should be enabled or traded based on these figures. Next validation must use complete M1/M5 data, a predeclared entry model, realistic exits, and out-of-sample evaluation.

## Lower-timeframe history investigation

The latest capture preserved the complete M15 arrays and the partial M1/M5 arrays for all markets. The recurring missing M1/M5 timestamps appear across multiple symbols, including a shared gap around 2026-11-02 13:00 UTC. The new public endpoint did not return the missing tick history for reconstruction.

The script also attempted the legacy WebSocket endpoint, but the connection was unavailable. Deriv's current documentation identifies the legacy API as retired; therefore it should not be treated as a dependable alternate history source. Current official API references:
- [API overview and public WebSocket endpoint](https://developers.deriv.com/docs/intro/api-overview/)
- [Ticks History](https://developers.deriv.com/docs/data/ticks-history/)
- [Legacy API retirement notice](https://staging-api.deriv.com/)

Recommended next step: retain this M15 screen as context-only evidence, remove reliance on the retired endpoint, and evaluate a forward-only public tick/candle collector to build a fresh contiguous M1/M5 dataset. Do not fill historical gaps with interpolated or fabricated candles. A forward collector must explicitly flag disconnects and missed intervals, and only a fully contiguous dataset may enter the full reversal replay.
