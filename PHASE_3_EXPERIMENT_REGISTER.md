# Phase 3 — Controlled Strategy Experiment Register

**Status:** Active research / shadow observation  
**Production baseline:** `MTF_BASELINE_V1`  
**Register version:** 1.0  
**Snapshot referenced below:** 2026-11-18 21:42 UTC  
**Purpose:** Evaluate candidate entry/confirmation methods without changing production signal generation, routing, risk rules, or execution.

## 1. Non-negotiable controls

- Production `MTF_BASELINE_V1` remains the control. Do not edit its signal criteria as part of Phase 3.
- Candidate strategies remain isolated research variants. A candidate result is not permission to replace production.
- No candidate may enqueue, submit, or execute an order. `MT5_EXECUTION_QUEUE_ENABLED=false` remains mandatory.
- Existing separately labelled strategy-comparison Telegram research alerts may continue under their existing feature flag. They are not production alerts and must never be represented as trade instructions.
- Use completed candles only. Entries are evaluated at the next candle open after the trigger; do not use a candle that was still forming at decision time.
- A candle that touches both stop and target is ambiguous, not a win or loss.
- Report pending, time-exit/expired, and ambiguous outcomes separately. Do not silently count them as losses or wins.
- Keep results separated by market, direction, entry timeframe, strategy version, and data-quality state.
- Do not tune parameters on the validation or holdout data. Record every parameter set before evaluating its forward sample.
- Record theoretical R separately from fills, spreads, slippage, and realized account P/L. Candle-range touches do not prove an executable fill.

## 2. Candidate register

| ID | Candidate | Entry design | Evaluation state |
|---|---|---|---|
| EXP-01 | M5 breakout / M1 retest | M5 range breakout, M1 retest confirmation, next-M1-open entry; 2R target; 60 M1-bar horizon | Forward shadow journal active |
| EXP-02 | M5 breakout / M5 retest / M15 trend | M5 breakout, fully closed M15 EMA20/50 directional confirmation, M5 retest, next-M5-open entry; 2R comparison target and separate production-style management simulation | Forward shadow journal active |
| EXP-03 | M15 trend + M5 EMA pullback | M15 trend signal, M5 EMA9/21 alignment and EMA9 pullback/reclaim, next-M5-open entry; 2R target; 12 M5-bar horizon | Forward shadow journal active |
| EXP-04 | M15 EMA comparison family | EMA20/50 control, EMA9/21, EMA9/21 with candle-quality gate, EMA20/50 pullback | Existing parallel comparison journal |
| EXP-05 | Offline M15 rule discovery | Frozen common entry/exit assumptions; parameter discovery on first chronological segment and validation on later segment | Research archive; not a live candidate |
| EXP-06 | Lower-timeframe entry research | Compare M5 and M1 entry paths from an M15 setup using common outcome assumptions | Collecting history; not ready for conclusions |

The candidates are not interchangeable. Their setup and entry timeframes, horizons, and outcome definitions differ. Do not rank them using raw target percentages across different designs. Where a fair comparison is required, replay the production baseline and candidate on the same market/time window with the same entry timing, stop/target management, horizon, and cost assumptions.

## 3. Initial forward-shadow snapshot

The following is a descriptive snapshot from the persisted journals at approximately 21:42 UTC on 2026-11-18. It is not a final scorecard and may change as journals update.

| Candidate | Signals | Resolved | Target before stop | Stop before target | Time exit | Ambiguous | Average recorded R |
|---|---:|---:|---:|---:|---:|---:|---:|
| EXP-01 | 62 | 62 | 21 | 39 | 1 | 1 | +0.054 |
| EXP-02 | 35 | 34 | 2 | 19 | 13 | 0 | -0.269 |
| EXP-03 | 11 | 11 | 0 | 6 | 5 | 0 | -0.357 |

Important interpretation notes:

- EXP-01 has a 35.0% target-before-stop rate among its 60 decisive outcomes (21 targets and 39 stops). Its average recorded R includes its time-exit result; it is not a forecast.
- EXP-02's 2R comparison stream and its separate production-style TP1/TP2 management simulation are different outcome streams. The production-style simulation showed 4 TP1 touches, 1 TP2, 19 stops before TP1, 14 time exits, and average recorded R of -0.281 across 34 resolved records in this snapshot.
- EXP-03 has only 11 observations. Its early negative result is a warning to keep observing, not enough evidence to reject it conclusively.
- Per-market samples are very small. Do not select or exclude markets based on these snapshots alone.
- These candidate outcomes are simulated from candle data, not broker fills or realized P/L.

## 4. Data readiness and quality

EXP-06's report snapshot (2026-11-18 21:42 UTC) was still in `collecting_lower_timeframe_history` mode, with zero qualified markets ready for analysis. It must remain labelled as collecting until the readiness checks pass. A market can have a large total candle count and still have a short latest continuous segment because of gaps.

Before a market enters an experiment evaluation:
1. Confirm M1/M5/M15 candle timestamps are aligned and continuous over the evaluation window.
2. Exclude incomplete candles.
3. Require the same overlapping time window for the candidate and its baseline comparison.
4. Record missing intervals, duplicate epochs, invalid candles, and the length of the latest continuous segment.
5. Do not bridge data gaps or infer candles that were not observed.

## 5. Evaluation gates

These are research-screening gates, not promises of statistical certainty or profitability.

### Gate A — Data and implementation integrity
- No look-ahead leakage.
- Correct next-candle entry timing.
- Same-candle stop/target touches marked ambiguous.
- No duplicate signal IDs or overlapping trades contrary to the candidate's frozen cooldown rule.
- Unit tests cover candle gaps, incomplete higher-timeframe candles, entry timing, stop/target ordering, and terminal outcomes.

### Gate B — Minimum forward evidence
- At least 50 resolved forward-shadow observations overall.
- Observations span at least 3 markets, with at least 10 resolved observations in each market included in pooled reporting.
- Report the exact number of signals, resolved outcomes, pending, time exits/expiries, and ambiguous outcomes.
- A candidate below these thresholds remains **insufficient evidence**; do not promote or reject it.

### Gate C — Matched baseline comparison
- Replay the production baseline on the exact same market/time windows and with identical entry, exit, horizon, and cost assumptions.
- Compare expectancy in R, target/stop/time-exit/ambiguous rates, drawdown sequence, signal frequency, and market coverage.
- Include conservative spread/slippage sensitivity. If cost data is unavailable, label results gross/theoretical and do not imply net profitability.
- Require the candidate to improve the pre-declared primary metric without materially worsening guardrails. Define the primary metric and guardrails before looking at the validation sample.

### Gate D — Independent holdout
- Freeze candidate parameters after discovery.
- Evaluate once on a later untouched chronological holdout.
- If a candidate is repeatedly modified after seeing holdout results, that holdout is no longer independent and a new one must be collected.

### Gate E — Promotion decision
A candidate can only be proposed for Phase 4 comparison after passing Gates A–D. Promotion to production is not part of Phase 3 and requires a separate review and explicit authorization.

## 6. Current Phase 3 order of work

1. Preserve all current candidate parameters and journals as the initial frozen snapshots.
2. Continue collecting forward observations without changing the candidates.
3. Repair or extend data-readiness coverage for EXP-06 before drawing conclusions.
4. Build a matched baseline-vs-candidate report using common market/time windows and consistent outcome definitions.
5. Review per-market and per-direction behavior only after minimum evidence is reached.
6. Select at most one or two candidates for a fresh, untouched validation period.

## 7. Explicitly out of scope

- Changing production entry/exit rules or alert eligibility.
- Changing Telegram routing or production alert wording.
- Enabling MT5 order execution.
- Claiming a candidate is profitable based on a small sample or candle-touch simulation.
- Optimizing parameters repeatedly against the same validation/holdout data.

**Phase 3 completion condition:** At least one candidate has passed the integrity, evidence, matched-baseline, and independent-holdout gates, or all candidates have been documented as not ready / rejected with adequate evidence. Phase 3 can also close with no candidate promoted.


## 8. Forward-evidence checkpoint — 2026-11-19 12:07 UTC

Snapshot source: successful collector artifact generated at `2026-11-19T12:07:08Z`. This is a descriptive update to the register, not a parameter change or promotion decision.

| Candidate | Signals | Terminal observations | Target before stop | Stop before target | Time exit | Ambiguous | Reported average R |
|---|---:|---:|---:|---:|---:|---:|---:|
| EXP-01 M5 breakout / M1 retest | 112 | 112 | 41 | 69 | 1 | 1 | +0.120 |
| EXP-02 M5 breakout / M5 retest / M15 trend | 62 | 62 | 5 | 35 | 22 | 0 | -0.237 |
| EXP-03 M15 trend + M5 EMA pullback | 29 | 29 | 0 | 17 | 12 | 0 | -0.417 |

EXP-01 per-market observations: R_10 13 (4 targets / 9 stops); R_25 19 (6 / 13); R_50 14 (8 / 6); R_75 14 (3 / 11); JD75 17 (3 / 14); JD100 8 (2 / 5, 1 time exit); CRASH500 10 (4 / 5, 1 ambiguous); BOOM500 17 (11 / 6). Seven markets have at least 10 observations; JD100 has 8 and should not be included in any pooled market subset requiring 10 per market.

EXP-01 therefore has materially more forward evidence than the earlier snapshot and clears the raw 50-observation count. This does **not** by itself certify Gate B or justify Phase 4: ambiguous/time-exit observations remain separately reported, and the exact qualifying market subset must be fixed in the analysis. Gate C still requires a candidate-specific matched production-baseline comparison on identical market/time windows and common assumptions.

**Holdout provenance correction (2026-11-19):** the earlier draft of this register incorrectly described a 26-trade holdout summary (13 target / 13 stop, +0.50R gross and +0.40R under an assumed 0.10R cost) as being supported by source commit `40dd1ce9f035b789d0708e7da440c36ab59eef3` and blob `9c5fb79fcae81378cef069948ac0dd9999e256ed`. Inspection shows that commit is a journal/archive update and the referenced blob is `lower_tf_research_candles.json`, containing candle data rather than a holdout result summary. Those references do **not** substantiate the claimed 26-trade result. Withdraw the numerical holdout claim; Gate D is **not verified** until the actual replay output, frozen parameter snapshot, chronological split boundaries, and exact trade sample can be located and audited. No holdout expectancy should be quoted from that earlier draft.

EXP-02 and EXP-03 remain below the 50-observation forward-evidence threshold. Their negative early results are descriptive warnings, not statistically sufficient rejection decisions.

EXP-06 remains blocked on R_10 M5 continuity. At the same snapshot, latest continuous M1/M5/M15 counts were 2,096 / 419 / 1,200, with 34.82 hours common overlap and zero invalid, duplicate or unaligned candles. The replay did not run. It must not be counted as completed evidence.

**Checkpoint decision:** Continue Phase 3. EXP-01 is the first candidate to prioritize for a rigorous candidate-specific matched-baseline audit; no candidate has been certified through Gates A–D, and no production promotion is proposed.


## 9. Candidate-specific baseline match audit — 2026-11-19 12:12 UTC

The latest `strategy_matched_comparison_report.json` snapshot was generated at `2026-11-19T12:12:06Z`. For EXP-01 (`M5_BREAKOUT_M1_RETEST`):

- Forward-shadow candidate observations: 112.
- Available production baseline population: 85 `MTF_BASELINE_V1` SCALP / M5 records.
- Same-market, same-direction, nearest-entry matches within 15 minutes: 9 of 112 candidates (8.0%); 103 candidates unmatched.
- The 9 pair labels were 7 candidate stops vs baseline expired, and 2 candidate TP2 vs baseline expired.
- The baseline outcomes in these pairs were all expired, so the report has no paired decisive baseline outcomes from which to estimate a meaningful paired expectancy difference.

This report is explicitly a contemporaneous co-occurrence match, not a counterfactual replay. Candidate and baseline entry/exit management and outcome horizons may differ. Therefore the 9 pairs do not satisfy Gate C, and the 8.0% match coverage is inadequate to support a comparative performance conclusion. The broader report's 87 matches across seven strategy families must not be attributed to EXP-01.

**Required next Gate C work:** build a candidate-specific common-assumption replay for EXP-01 and the production baseline on identical market/time windows, using the same entry timing, stop/target, horizon, outcome resolution and conservative cost sensitivity. If data is insufficient for that replay, record Gate C as not ready rather than extrapolating from the current co-occurrence matches.

**Checkpoint decision remains:** Phase 3 active; EXP-01 is the priority research candidate, but it has not passed the matched-baseline gate or been certified for Phase 4. No production changes or promotion.


## 10. R10 lower-timeframe replay checkpoint — 2026-11-19 19:02 UTC

Source snapshots: `lower_tf_entry_research_report.json` and `lower_tf_common_assumption_replay_report.json`, both generated at approximately 19:02 UTC by successful collector run #410.

**Data readiness:** R_10 reached 2,511 latest-continuous M1 candles, 502 M5 candles, and 1,200 M15 candles, with 41.82 hours of common overlap. Invalid, duplicate, and unaligned candle counts were zero. The report changed to `ready_for_lower_timeframe_replay`, and the collector successfully ran the replay step.

**Preliminary replay output:** one market (R_10) was replayed, with only 9 M15 setup candidates in the common 41.82-hour window. The three methods produced:
- M15 next-open baseline: 5 entries (3 discovery, 1 validation, 1 holdout); all were time exits.
- M5 EMA pullback: 5 entries (3 discovery, 1 validation, 1 holdout); 4 time exits and 1 holdout stop.
- M1 micro-break: 4 entries (2 discovery, 1 validation, 1 holdout); all were time exits.

The validation and holdout samples are therefore only one trade per method each. These results are exploratory gross candle-based R, with no spread, commission, or slippage assumptions. They are far too small for ranking, Gate C certification, or a promotion decision. The report itself states that it is not sufficient for strategy ranking or production promotion.

**Integrity correction:** code review found that the replay report declared a one-hour embargo at each split boundary, but the split-boundary function did not actually exclude the post-boundary hour before validation and holdout. The existing replay logic already purged setups whose 60-minute outcome horizon crossed a split end. The preliminary 19:02 split results must be treated as diagnostic only and not as independent holdout evidence until the embargo correction is tested and a fresh replay is generated.

**Repair under review:** draft PR [#125](https://github.com/kanyesigyeanthony79-byte/Deriv-bot/pull/125) adds the explicit post-boundary embargo, adds a unit test for the split windows, and fixes the lower-timeframe test workflow path filters so changes to the common-assumption replay and its test file actually trigger CI. The Lower-Timeframe Research Tests workflow passed on the updated PR head at 19:06 UTC. The PR remains unmerged pending the remaining CI checks and review.

**Checkpoint decision:** R10 data readiness is achieved and an initial replay has been generated, but EXP-06 remains exploratory. No candidate has passed Gates A–D; Phase 3 remains active, and Phase 4 remains on hold. Production signal rules, Telegram routing, and MT5 execution settings remain unchanged.


## 11. Latest collector and replay snapshot — 2026-11-19 19:07 UTC

Source: main-branch collector artifacts generated at approximately `2026-11-19T19:07:25Z`; collector run succeeded.

**R_10 data continuity:** latest continuous segments contain 2,516 M1 candles and 503 M5 candles; M15 contains 1,200 candles. Common overlap remains 41.82 hours. The complete retained datasets show one earlier gap on M1 and M5, but no gaps, duplicates, invalid candles, or unaligned timestamps inside the latest continuous segments. This meets the replay's minimum segment and overlap gates.

**Fresh main-branch replay:** the replay artifact was regenerated with 9 R_10 setup candidates. The current artifact still shows validation and holdout starts exactly at their split boundaries, with no one-hour post-boundary exclusion. This is expected because the embargo correction is on draft PR #125 and has not been merged or run by the production collector. Therefore this latest main-branch replay remains diagnostic and must not be treated as corrected independent holdout evidence.

Per-method counts remain extremely small:
- M15 next-open: 3 discovery, 1 validation, 1 holdout entry.
- M5 EMA pullback: 3 discovery, 1 validation, 1 holdout entry.
- M1 micro-break: 2 discovery, 1 validation, 1 holdout entry.

The single holdout outcome per method is not a valid basis for selecting or rejecting a strategy. Results are gross candle-based R and exclude transaction costs.

**PR #125 verification:** the draft branch contains the explicit 3,600-second post-boundary embargo and a unit test for the split starts. Lower-Timeframe Research Tests, Multi-Timeframe Engine Tests, and MT5 integration tests all passed on commit `6ebafe302093af026887193ce12104f32366fab0`. A later register-only documentation commit is now the PR head; no new code change was made after those passing tests. PR #125 remains open and unmerged.

**Checkpoint decision:** R_10 minimum replay data is available, but corrected replay evidence is still pending. Continue Phase 3. No strategy promotion, production signal changes, Telegram routing changes, or MT5 execution enablement.
