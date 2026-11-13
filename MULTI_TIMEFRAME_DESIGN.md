# Multi-Timeframe Signal Engine — Development Branch

This work is isolated on `feature/multi-timeframe-engine`. It does not modify the production scanner, production dashboard, production journal, or Telegram Worker.

## Signal horizons

| Category | Entry chart | Confirmation | Higher-timeframe context | Risk/target volatility basis |
| --- | --- | --- | --- | --- |
| Scalping | M1 | M5 | M15 | M15 |
| Short-term | M5 | M15 | H1 | H1 |
| Swing | H1 | H4 | D1 | H4 |
| Position | H4 | D1 | W1 | D1 |

The category describes the intended opportunity horizon, not a guaranteed holding time. A lower-timeframe entry is only accepted when its direction agrees with both confirmation and context bias.

## Safety and correctness rules

- The engine consumes completed candles only; the data-fetching caller is responsible for excluding incomplete candles.
- Candles must be oldest-to-newest, have strictly increasing epochs, and valid OHLC values.
- Each signal ID includes market, category, and entry-candle epoch so different horizons on the same market do not collide.
- Each category has separate entry, stop-loss, TP1, TP2, risk timeframe, and maximum monitoring age metadata.
- Conflicting timeframe directions return `timeframe_conflict`; they are not silently converted into a trade.
- Weekly candles are aggregated from completed daily candles using UTC Monday week boundaries. The incomplete current week is excluded.
- No order execution, live alerts, or production state changes are performed by this module.

## Integration plan

1. Unit-test the pure analysis engine.
2. Add a separate multi-timeframe data collector for all eight configured markets, initially in observation mode.
3. Add category-aware journal and outcome monitoring with independent signal IDs.
4. Add dashboard filters and category-specific reporting.
5. Validate data load, runtime, alert cadence, and historical/demo outcomes before considering any production cutover.

## Runtime consideration

The existing production workflow runs every five minutes. That cadence cannot reliably capture every M1 entry. A future collector must use an appropriately frequent schedule or a persistent streaming process, while keeping API request volume and GitHub Actions runtime within limits. Do not change the existing production schedule as part of this isolated engine phase.

## Tests

Run with Node.js 22:

```sh
node --check multi_timeframe_engine.js
node --test test/multi_timeframe_engine.test.js
```
