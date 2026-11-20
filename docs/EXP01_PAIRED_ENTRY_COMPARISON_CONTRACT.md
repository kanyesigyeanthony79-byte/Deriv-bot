# EXP-01 Paired Entry Comparison Contract

Status: proposed research protocol; not yet implemented or approved for strategy selection.

## Why this contract is needed

The current `exp01_matched_replay.js` report compares two different signal-generation methods under shared risk, target, and outcome assumptions. The production MTF baseline requires M15 confirmation/context alignment, while EXP-01 records M15 context but does not use it as a directional eligibility filter. The current report correctly discloses that mismatch. It is therefore a strategy-package comparison, not an entry-only experiment.

The current implementation also generates the baseline and EXP-01 setup lists independently. Their trades are not paired observations of the same underlying setup. A pooled difference between their average R values must not be described as the causal effect of changing entry timing.

## Two analyses must remain separate

1. **Primary paired entry experiment (new):** compare two entry policies on the same frozen eligible setup events. This is the only analysis that may support an entry-method conclusion.
2. **Secondary native-strategy comparison (existing):** retain the independently generated production MTF and native EXP-01 setup streams. Report them as distinct strategy packages, with their eligibility differences prominently stated. Do not call this an entry-only or matched comparison.

Do not combine the two analyses into one score or rank.

## Primary paired experiment: frozen event cohort

### Event eligibility and identity

- Use the production MTF baseline's completed-candle setup eligibility and direction as the shared event gate for both entry policies. Do not allow EXP-01 to introduce additional eligible setup events into the primary paired cohort.
- Freeze the event only after all required M5 and M15 candles have closed. Record market, setup candle epoch, direction, and the exact input candle epochs used.
- The immutable pair key is `marketId + setupEpoch + direction`. There must be at most one event per key.
- Both policies receive the same event, direction, market, and observation window. Neither may inspect a future candle or use an incomplete higher-timeframe candle.
- The candidate policy may wait for its frozen M5 breakout and M1 retest confirmation only after the shared event. Set and freeze a maximum wait of three completed M5 bars (15 minutes) after the event. If it does not trigger in that window, record a candidate no-entry; do not silently drop the event.
- The baseline policy enters at the next eligible M5 open after the shared event. If the required next candle is unavailable, record a baseline no-entry/data-quality reason.

### Entry, risk, and outcome controls

- Baseline entry: next M5 open after the shared eligible event.
- EXP-01 entry: next M1 open after the frozen M5 breakout plus M1 retest confirmation, within the 15-minute maximum wait.
- Both use the same direction supplied by the shared event. EXP-01's own breakout direction must agree with that direction; otherwise record a directional-mismatch no-entry.
- Use one common risk distance measured from the shared setup event: 1.25 x ATR(14) on the last completed M15 candle available at that event. Do not recalculate risk at the later candidate entry.
- Use a fixed 2R target, a 60-minute outcome horizon from each actual entry, and completed M1 candles for resolution. Same-candle stop/target touches remain ambiguous.
- Keep the existing one-position-per-market-per-policy constraint, but apply it consistently to both policies. Record every skipped event and reason.
- Do not convert missing data, gaps, ambiguous outcomes, or no-entry events into losses or zero-R trades. Report them separately.
- Cost sensitivities remain hypothetical deductions of 0.05R, 0.10R, and 0.20R until broker-specific spread, commission, and slippage data are available.

## Required reporting

For each market and split, report:

- Shared eligible event count and unique pair-key count.
- Baseline and candidate entries, no-entries by reason, overlap-skipped events, split-end purges, incomplete horizons, data gaps, and ambiguous outcomes.
- Entry coverage for each policy: entries divided by shared eligible events.
- Conditional trade expectancy and outcome mix among resolved entries, clearly labelled as conditional on entry.
- Paired cohort coverage: events where both policies produced valid resolved entries.
- Paired per-event difference `candidate realized R - baseline realized R` only for events where both policies have valid resolved outcomes. Report pair count, mean and median difference, and a confidence interval; do not infer a difference when pair count is inadequate.
- Also report an intention-to-treat-style event accounting table showing all shared eligible events and each policy's no-entry/entry status. Do not assign zero R to no-entry events.
- Market-level results before pooled results; no market may be hidden by pooling.
- Discovery results first. Validation is descriptive confirmation only after the comparison contract is frozen. Holdout remains sealed and unavailable for tuning.

## Statistical and decision safeguards

- Preserve chronological per-market discovery/validation splits and the one-hour embargo. Purge any setup whose full 60-minute outcome horizon crosses a split boundary.
- The existing minimum sample safeguards (50 resolved observations overall, at least 10 resolved observations in each of at least 3 markets, and no more than 5% ambiguous entries) remain minimum data-sufficiency checks, not proof of profitability.
- Add a separate minimum of 50 valid paired resolved events before making an entry-method comparison claim; report uncertainty intervals and market clustering. If fewer than 50 pairs exist, label the paired result exploratory and inconclusive.
- Freeze this contract and the implementation version before collecting the next evaluation cohort. Do not alter parameters after viewing validation results.
- The current historical holdout is already contaminated by existing forward-shadow observations and must remain sealed. Gate D requires a later untouched forward period after this contract is frozen.
- No production signal, Telegram, scheduler, or MT5 execution behavior may change as part of this research work.

## Acceptance tests required before using the paired report

1. Each shared eligible event creates exactly one pair key and both policy records reference it.
2. The two policies receive identical market, direction, event time, risk distance, target multiple, and outcome horizon definition.
3. A candidate breakout in the opposite direction is recorded as a no-entry, not a reversed trade.
4. Candidate no-entry after 15 minutes is retained in event coverage accounting.
5. No-entry, overlap skip, split purge, ambiguous, incomplete, and data-gap states are distinct and never counted as resolved trades.
6. A paired R difference is emitted only when both records for the same pair key have resolved outcomes.
7. Split-boundary embargo/purge rules apply identically to both policies.
8. Holdout output remains sealed and contains no evaluated performance statistics.
9. Tests prove no future M15 candle is read by either policy.
10. The existing native-strategy comparison remains separately labelled and unchanged until the paired implementation passes tests.

## Current status

This document defines the proposed next comparison contract only. The existing EXP-01 replay output is not retroactively matched by this protocol. No strategy is promoted, rejected, or altered by this document.
