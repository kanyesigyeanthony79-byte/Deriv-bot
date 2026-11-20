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

## 12. Post-merge embargo verification and fresh replay — 2026-11-19 19:11 UTC

Source: successful main-branch collector run #412 (workflow run 44595577996), on merge commit `7febd5f2f5ad9bc69ee2d51d1fb50efdea312501`. The collector completed its candle collection, lower-timeframe archive, common-assumption replay, daily archive build, and isolated observation-journal persistence steps successfully.

**Code and CI status:** PR #125 was merged. The Lower-Timeframe Research Tests and MT5 execution integration tests both passed on the merge commit. The collector workflow also succeeded. The Pages build phase succeeded, but its deployment job was cancelled; do not infer a successful website deployment from this run.

**Embargo verification:** the newly generated `lower_tf_common_assumption_replay_report.json` was generated at `2026-11-19T19:11:13.196Z`. Its actual R_10 split bounds now show:
- Discovery: 1794964260–1795054584.
- Validation: starts at 1795058184, exactly 3,600 seconds after discovery ends; ends at 1795084692.
- Holdout: starts at 1795088292, exactly 3,600 seconds after validation ends; ends at 1795114800.

The report assumptions also explicitly describe the post-boundary embargo and the separate purge of setups whose 60-minute outcome horizon crosses a split end. This verifies that the corrected split logic was used in the fresh replay.

**Fresh replay sample size:** the corrected split leaves zero validation entries for all three methods. Each method has only one holdout entry:
- M15 next-open: one holdout time exit, -0.1224 gross R.
- M5 EMA pullback: one holdout stop, -1.0000 gross R.
- M1 micro-break: one holdout time exit, -0.4160 gross R.

Discovery entries were 3 for M15 next-open, 3 for M5 EMA pullback, and 2 for M1 micro-break. The other eligible discovery setups and overlap-skipped setups are itemized in the replay JSON. These samples cannot support a ranking, rejection, validation conclusion, or Gate D pass. The validation segment having zero entries is a particularly clear sign that the available 41.82-hour common overlap is too short for this split design.

**Updated data/archive snapshot:** the lower-timeframe readiness report generated at 19:11:12 UTC shows R_10 latest continuous segments of 2,519 M1 candles, 504 M5 candles, and 1,200 M15 candles, with 41.8167 hours of common overlap. There are no duplicate, invalid, or unaligned candles in those latest segments; one older gap remains in M1 and M5 histories. The daily archive generated at 19:11:13 UTC now covers 7 recoverable dates (2026-11-13 through 2026-11-19), with 80 legacy signals, 403 MTF observations, 6 verified daily reports, and 1 reconstructed day. The 19 Nov record remains explicitly reconstructed from journals, not a verified Telegram daily report.

**Checkpoint decision:** the embargo repair is merged, tested, and confirmed in a fresh replay. However, the corrected replay is too small to evaluate the methods. Continue Phase 3 by collecting a longer uninterrupted common M1/M5/M15 window before rerunning the same frozen experiment. Do not tune on the one-trade holdout, do not treat it as an independent performance verdict, and do not advance to Phase 4. Gates A–D are not certified; no production signal, Telegram routing, or MT5 execution settings are changed.

## 13. Scheduled research-only candle collection — 2026-11-19 19:16 UTC

**Change:** PR [#126](https://github.com/kanyesigyeanthony79-byte/Deriv-bot/pull/126) was merged as commit `ec64cfd1f6331a191bb6a6123eacd44f730a3e92`. It adds `.github/workflows/research-candle-collector.yml`, scheduled every 15 minutes, with manual dispatch also available.

**Isolation controls:** this workflow runs the existing collector and research/archive builders but explicitly sets `MTF_TELEGRAM_ALERTS=false`, `STRATEGY_COMPARISON_TELEGRAM_ALERTS=false`, `MT5_TRADE_REPORTING_ENABLED=false`, and `MT5_EXECUTION_QUEUE_ENABLED=false`. It does not pass Telegram or MT5 secrets. It shares the existing `deriv-signal-scanners` concurrency group to serialize journal writes against the production scanner/collector. It persists the same research/archive journals and uploads a seven-day collection snapshot.

**Validation status:** the PR's Multi-Timeframe Engine Tests workflow passed, including syntax check and unit tests. The schedule becomes active from main after merge. The first scheduled execution has not yet been observed at the time of this entry; do not describe collection as continuously running until that first run and subsequent persistence are verified.

**Research objective:** grow the uninterrupted M1/M5/M15 R_10 common window and allow the frozen chronological replay to produce adequate validation and holdout samples. No candidate parameters were changed. No Telegram delivery or MT5 execution was enabled. Phase 3 remains active and Phase 4 remains on hold.



## 14. First verified research-only collector run and watchdog recovery — 2026-11-19 19:30 UTC

**Watchdog repair:** PR [#127](https://github.com/kanyesigyeanthony79-byte/Deriv-bot/pull/127) was merged at commit `5df99a469647e4fe14386965ec52ef228db5bf5d`. It adds the research-only collector workflow to the existing scanner watchdog. The watchdog uses a 25-minute stale threshold for this 15-minute schedule and retains the existing 10-minute recovery cooldown. The watchdog run #577 (ID `44598935863`) completed successfully; its follow-up workflow-run watchdog execution also completed successfully.

**First verified research-only execution:** the watchdog dispatched research-only collector run [#44598979302](https://github.com/kanyesigyeanthony79-byte/Deriv-bot/actions/runs/44598979302) at 19:30:16 UTC. It completed successfully at 19:30:53 UTC. Every job step succeeded: candle collection with delivery/execution paths disabled, lower-timeframe candle archiving, common-assumption replay, daily archive rebuild, journal persistence, and artifact upload. Artifact `scheduled-research-observation-data` was created (727,475 bytes; SHA-256 `4d26abf7f18898b809495d06d373b6d1bb41c0d58f18b239404bd2e2927b49bb`) and is retained until 2026-11-26. This verifies one successful manual recovery dispatch, not yet sustained 15-minute scheduled cadence.

**Isolation:** the workflow file continues to explicitly set `MTF_TELEGRAM_ALERTS=false`, `STRATEGY_COMPARISON_TELEGRAM_ALERTS=false`, `MT5_TRADE_REPORTING_ENABLED=false`, and `MT5_EXECUTION_QUEUE_ENABLED=false`. The successful run does not represent Telegram delivery or MT5 trade execution.

**Updated R_10 readiness snapshot:** generated at `2026-11-19T19:30:45.399Z`. Latest continuous segments: M1 2,539 candles; M5 508; M15 1,200. Common overlap is 42.3167 hours. The full retained M1 and M5 histories each contain one earlier gap; M15 contains none. Latest-segment duplicate, invalid, and unaligned timestamp counts are zero. The largest observed intervals remain 1,440 seconds (M1), 1,500 seconds (M5), and 900 seconds (M15). The readiness mode remains `ready_for_lower_timeframe_replay`.

**Corrected common-assumption replay:** generated at `2026-11-19T19:30:45.588Z`, with 9 setup candidates. The actual split starts retain the full one-hour post-boundary embargo: validation starts 3,600 seconds after discovery ends; holdout starts 3,600 seconds after validation ends. Results remain very small:
- M15 next-open: discovery 3 entries / 3 resolved / -0.4311 gross R; validation 1 / 1 / -1.0000R (stop); holdout 1 / 1 / -0.1224R (time exit).
- M5 EMA pullback: discovery 3 / 3 / +0.5256R; validation 0; holdout 1 / 1 / -1.0000R (stop).
- M1 micro-break: discovery 2 / 2 / -0.3102R; validation 0; holdout 1 / 1 / -0.4160R (time exit).

All reported R values are gross candle-based simulations, not broker fills or realized account P/L, and exclude spread, commission, and slippage. The one-entry holdouts and zero/one-entry validation samples cannot support method selection, rejection, Gate C, or Gate D. No tuning is authorized from these results.

**Updated daily archive:** generated at `2026-11-19T19:30:45.674Z`; 7 recoverable dates (13–19 Nov), 81 legacy signals, 408 MTF observations, 6 verified daily reports, and 1 reconstructed day. The reconstructed 19 Nov day remains distinct from verified original daily reports.

**Checkpoint decision:** one successful research-only collection and persistence cycle is now verified, and watchdog recovery is active. Continue collecting to establish repeated scheduled operation and a longer uninterrupted common M1/M5/M15 window. Phase 3 remains active; Gates A–D are not all certified; Phase 4 remains on hold. No strategy promotion, production signal-rule change, Telegram delivery, or MT5 execution is authorized by this checkpoint.


## 15. Phase 3 evidence checkpoint — 2026-11-20 04:28 UTC

Source: main-branch research reports generated at approximately `2026-11-20T04:27:24Z`, plus the native GitHub Actions schedule-event audit completed at approximately 04:27:52 UTC.

**R_10 lower-timeframe data readiness:**
- M1: 5,000 retained candles; latest continuous segment 3,076.
- M5: 2,000 retained candles; latest continuous segment 615.
- M15: 1,200 retained candles; latest continuous segment 1,200.
- Common M1/M5/M15 overlap: 51.0667 hours.
- One older gap remains in M1 and M5 retained histories; M15 has no gaps. The latest report shows zero duplicates, invalid candles, or unaligned epochs in the focus market.
- The M5 latest continuous segment exceeds the 500-candle replay threshold. The separate 20-reliable-cycle operational criterion is not established by this count.

**Fresh corrected common-assumption replay:** generated at `2026-11-20T04:27:24.916Z`, using the frozen M15-next-open, M5 EMA pullback, and M1 micro-break methods, common 1.5 × M15 ATR risk, 2R target, M1 outcome resolution, 60-minute horizon, chronological 60/20/20 splits, one-hour post-boundary embargoes, and split-end outcome purging. The R_10 common window contains 11 setup candidates.

| Method | Discovery entries / gross R | Validation entries / gross R | Holdout entries / gross R |
|---|---:|---:|---:|
| M15 next-open baseline | 4 / +0.3580R | 2 / -1.1224R | 1 / +0.9963R |
| M5 EMA pullback | 4 / +1.0902R | 0 / no entry | 1 / +1.0189R |
| M1 micro-break | 3 / +0.0802R | 1 / -0.4160R | 1 / +0.7958R |

These are gross candle-based R simulations, not broker fills or realized account returns; spread, commission, and slippage are not included. The validation and holdout samples remain far too small for ranking, rejection, or a Gate C/D pass. In particular, zero M5 validation entries is not evidence of either profitability or failure. Do not tune parameters from this holdout.

**Research-only schedule audit:** the native GitHub `schedule` event query still finds exactly one run of `research-candle-collector.yml`: run [#44653745350](https://github.com/kanyesigyeanthony79-byte/Deriv-bot/actions/runs/44653745350), successful at `2026-11-20T01:27:23Z`. The latest watchdog audit inspected one scheduled run, zero failures, and correctly marked cadence evidence insufficient. The required three successful native schedule runs at approximately 15-minute intervals have not yet been observed. Cloudflare-triggered `workflow_dispatch` production collector runs are a separate process and do not count toward this requirement. The research collector watchdog has `autoRecover: false`, so a manual recovery cannot disguise a missing native schedule event.

**Daily performance archive:** generated at `2026-11-20T04:27:24.991Z`; covers 13–20 November (8 recoverable days), 97 legacy signals, 476 multi-timeframe observations, 7 verified daily reports, and 1 reconstructed day. The 20 November record is reconstructed from journals and has no saved original daily-report delivery record. Historical gaps remain unfilled rather than fabricated.

**Gate status and decision:** Phase 3 remains active. Gate A is not fully certified for all candidates; EXP-06 remains an exploratory lower-timeframe replay with a very small sample. Gate B must be assessed candidate-by-candidate from forward-shadow journals, not inferred from this 11-setup replay. Gate C's matched baseline audit and Gate D's independent holdout are not certified for EXP-06. No candidate is promoted, no production signal rules or Telegram routing are changed, and MT5 execution remains disabled. Continue collecting and preserve the frozen experiment definitions. Phase 4 remains on hold.


## 16. EXP-01 forward-evidence Gate B review — 2026-11-20 04:30 UTC

Sources: `breakout_retest_shadow_journal.json` and `strategy_matched_comparison_report.json`, both generated at `2026-11-20T04:27:05Z`. This review evaluates EXP-01 only; it does not change its frozen parameters.

**Gate B — forward evidence:** the EXP-01 M5 breakout / M1 retest journal contains 178 forward-shadow observations, all explicitly marked `evaluationSource=forward_shadow`. Of these, 177 have numeric terminal R outcomes and one is ambiguous. The 177 resolved observations are distributed across eight markets:

| Market | Resolved observations |
|---|---:|
| R_10 | 24 |
| R_25 | 28 |
| R_50 | 19 |
| R_75 | 23 |
| JD75 | 25 |
| JD100 | 20 |
| CRASH500 | 16 |
| BOOM500 | 22 |

Terminal status counts are 114 stopped, 60 TP2 hits, 3 time exits, and 1 ambiguous (178 total). Each of the eight markets has at least 10 resolved observations, and the total exceeds the 50-observation threshold. **EXP-01 meets the numerical Gate B evidence thresholds in this snapshot.** This is a sample-size/evidence-coverage finding only; it is not a profitability conclusion or a Gate C/D pass.

**Gate C — current match audit is insufficient:** the contemporaneous co-occurrence report lists 11 EXP-01 / MTF baseline pairs and 167 unmatched candidate observations. Of the 11 pairs, 7 are candidate stops against an expired baseline, 3 are candidate TP2 hits against an expired baseline, and 1 pair has both sides stopped. The baseline's numeric realized-R field is null even in that final pair. The report explicitly warns that this is not a counterfactual replay: entries, stop distances, targets, management, and horizons can differ. An unmatched baseline is not a baseline loss. Therefore these 11 pairs do not provide a valid expectancy comparison and **Gate C remains not passed**.

**Next Phase 3 work for EXP-01:** build or verify a candidate-specific matched replay on identical market/time windows, with the baseline and EXP-01 evaluated using the same entry/exit assumptions, risk distance, outcome horizon, and conservative cost sensitivity. Declare the primary metric and guardrails before reading the validation sample. Preserve a fresh untouched chronological holdout for Gate D. Do not tune EXP-01 from its current forward outcomes or use the contemporaneous match report to claim an edge.

**Decision:** Gate B numerical thresholds are met for EXP-01 in this snapshot. Gate A implementation integrity still requires complete candidate-specific audit; Gate C and Gate D remain unverified. No candidate is promoted, no production signal or Telegram behavior changes, and MT5 execution remains disabled.


## 17. EXP-01 common-assumption entry-method replay implementation — 2026-11-20 04:38 UTC

Implementation merged in [PR #133](https://github.com/kanyesigyeanthony79-byte/Deriv-bot/pull/133), commit `055dba90f3731794fa20a210c8cf30addb232913`. The first real-data report has not yet been generated; therefore this entry records the methodology and implementation status, not a Gate C result.

**Comparison populations:**
- Production control: `MTF_BASELINE_V1` SCALP category, evaluated on completed M5 candles with completed M15 confirmation/context; enter at the next M5 open.
- EXP-01: frozen M5 breakout beyond the prior 12-bar range, then completed M1 retest confirmation; enter at the next M1 open.
- Both are evaluated over the same market-specific common M1/M5/M15 continuous window.

**Common outcome contract:**
- Stop distance: 1.25 × completed M15 ATR at the M5 setup close, applied identically to both entry methods.
- Target: fixed 2R.
- Outcome resolution: completed M1 candles over 60 minutes.
- Same-candle stop and target touches: ambiguous, excluded from numeric expectancy.
- One open position per method per market; overlapping setups are skipped.
- Chronological 60/20/20 discovery/validation/holdout boundaries, one-hour post-boundary embargoes, and split-end outcome purging.
- Report gross candle R plus hypothetical 0.05R, 0.10R and 0.20R round-trip deductions. These are sensitivity scenarios, not measured broker costs.

**Pre-declared comparison framework:** primary metric is mean R after the hypothetical 0.10R deduction per resolved observation. Report drawdown sequence, signal frequency, market coverage, outcome categories and the other cost sensitivities as guardrails/context. The assumed cost deductions must not be described as actual net returns.

**Scope limitation:** this isolates the entry-method difference. It intentionally replaces EXP-01's original M1-local stop sizing with the production SCALP M15-ATR stop so both methods share the same risk/exit contract. It is not a full reproduction of EXP-01's original trade management and cannot alone certify Gate C.

**Holdout protection:** the current 20% chronological holdout partition is sealed and not evaluated because the existing forward-shadow journal already covers this period. Gate D still requires a later untouched period after the comparison contract is frozen. The report generator emits the holdout as `sealed_not_evaluated`.

**Status:** implementation tests passed on PR #133 (Lower-Timeframe Research Tests, Multi-Timeframe Engine Tests, and MT5 execution integration tests). The replay report is pending its next successful research-only collector execution. Gate C and Gate D remain unverified; no production rules, Telegram routing, or MT5 execution settings were changed.


## 18. R10 replay and research-history expansion checkpoint — 2026-11-20 07:46 UTC

**Source snapshot:** lower_tf_entry_research_report.json and lower_tf_common_assumption_replay_report.json generated at approximately 2026-11-20T07:46:13Z. This snapshot predates the merge of research-output isolation PR #144; it is retained as a valid earlier research observation, not represented as a post-isolation scheduled run.

**R_10 readiness:**
- M1: 5,000 retained candles; latest continuous segment 3,274.
- M5: 2,000 retained candles; latest continuous segment 655.
- M15: 1,200 retained candles; latest continuous segment 1,200.
- One older gap remains in M1 and M5. Duplicate, invalid, and unaligned counts are zero.
- The common latest continuous window is approximately 54.6 hours. The replay contains 13 setup candidates.

**Corrected EXP-06 common-assumption replay:** frozen methods, common 1.5 × M15 ATR risk, 2R target, M1 outcome resolution, 60-minute horizon, chronological 60/20/20 splits, one-hour post-boundary embargoes, and split-end outcome purging.

| Method | Discovery entries / gross R | Validation entries / gross R | Holdout entries / gross R |
|---|---:|---:|---:|
| M15 next-open | 4 / +0.3580R | 1 / -0.1224R | 2 / +0.9160R |
| M5 EMA pullback | 4 / +1.0902R | 1 / -1.0000R | 2 / +0.7685R |
| M1 micro-break | 3 / +0.0802R | 1 / -0.4160R | 2 / +0.5454R |

The validation and holdout samples remain too small for method selection, rejection, or Gate C/D certification. Outcomes are gross candle-based simulations; transaction costs and executable fills are not included. Do not tune parameters from this sample.

**Research isolation:** PR #144 was merged as e96c4320364b71af1f14293e7947a46fe90bcd09. The research collector now writes research-prefixed files and has a separate concurrency group. Its Telegram and MT5 reporting/execution flags remain false. A post-merge native scheduled run is still required to verify the isolated workflow end to end.

**History-retention repair:** PR #147 was merged as 86c0e662fe2eb5414e4d6154ee2dc1dad5ab13a5. R_10-only research retention is now M1 15,000, M5 4,000, and M15 1,800 candles; other markets retain their prior caps. Regression tests passed. The larger window will accumulate gradually from subsequent scheduled observations; it does not reconstruct missing candles or bridge gaps. A fresh replay is required after enough additional continuous data has accumulated.

**Decision:** Phase 3 remains active. EXP-06 is still exploratory and insufficient for conclusions. No candidate has passed Gates A–D, no strategy is promoted, production signal rules remain unchanged, and Phase 4 remains on hold.
