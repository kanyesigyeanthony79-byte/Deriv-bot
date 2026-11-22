# BUY Confirmation Shadow Configuration

**Version:** `BUY_CONFIRMATION_SHADOW_V1`  
**Status:** Draft, disabled, shadow-only

## Objective

Test whether stricter BUY-side confirmation improves the weak BUY cohorts without changing current Telegram delivery, MT5 queueing, SELL behavior, or outcome tracking.

The configuration applies only to BUY signals in these market/category groups:

- JD100: SCALP and SHORT_TERM
- R_10: SCALP and SHORT_TERM
- R_75: SCALP and SHORT_TERM
- CRASH500: SCALP and SHORT_TERM

All other signals continue using the current rules while the experiment is running.

## Proposed gate

A scoped BUY signal passes the shadow gate only when all of the following are true:

- Score is at least **85** and quality is `STRONG`.
- Confirmation timeframe remains BUY-aligned, with EMA separation of at least **0.25 ATR** and trend slope of at least **0.05 ATR**.
- Context timeframe remains BUY-aligned, with EMA separation of at least **0.15 ATR** and trend slope of at least **0.02 ATR**.
- Entry candle body ratio is at least **0.55**.
- Entry candle close location is at least **0.65**, meaning the close is in the upper portion of the candle range.
- Entry extension from EMA20 is no greater than **1.0 ATR**.

These fields already exist in the multi-timeframe signal metrics, so the experiment does not require a new indicator or a look-ahead calculation.

## Shadow behavior

The original signal must still be journaled and outcome-tracked. The shadow decision is recorded separately with pass/fail reasons and near-miss details. Current Telegram and MT5 routing remains unchanged while data is collected.

The configuration is intentionally set to `enabled: false` and must not be connected to production routing without a separate approval and code change.

## Evaluation gates

Wait for at least:

- 7 complete forward-shadow days
- 50 original scoped BUY signals
- 25 shadow-accepted BUY signals
- 20 resolved shadow outcomes

Do not activate the gate unless it improves resolved win rate and removes no more than 40% of eligible BUY observations. Review expiry rate and delivery rate alongside win rate; a higher win rate caused only by removing nearly all signals is not an acceptable result.

## Important caution

The thresholds are a test configuration, not a claim that these values are optimal. They should be evaluated on unseen forward data and compared with the unchanged current BUY population. SELL rules are deliberately not changed in this experiment.
