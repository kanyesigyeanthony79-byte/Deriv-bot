"use strict";
// Paired EXP-01 entry-policy replay. Offline research only; does not alter native replay.
const { TIMEFRAMES, evaluateCategory } = require("./multi_timeframe_engine");
const { detectBreakout, findRetestConfirmation, atrSeries } = require("./breakout_retest_shadow");
const { latestContinuousSegment, splitBounds, resolveCommonOutcome, atr, STOP_ATR_M15, TARGET_R, HORIZON_SECONDS, MARKETS } = require("./exp01_matched_replay");

const MAX_CANDIDATE_WAIT_SECONDS = 3 * TIMEFRAMES.M5;
const MIN_M5_INDEX = 64;

function pairKey(marketId, setupEpoch, direction) {
  return marketId + "|" + setupEpoch + "|" + direction;
}

function candidateEntry({ m1, m5, m5Index, m1Atr, breakout, setupEpoch, direction }) {
  if (!breakout) return { status: "no_entry", reason: "no_candidate_breakout", entryEpoch: null, entry: null };
  const candidateDirection = breakout.direction === 1 ? "BUY" : "SELL";
  if (candidateDirection !== direction) return { status: "no_entry", reason: "directional_mismatch", entryEpoch: null, entry: null };
  const startIndex = m1.findIndex(c => c.epoch === setupEpoch);
  if (startIndex < 0) return { status: "no_entry", reason: "candidate_data_unavailable", entryEpoch: null, entry: null };
  const confirmation = findRetestConfirmation(m1, startIndex, breakout, m1Atr);
  if (!confirmation) return { status: "no_entry", reason: "confirmation_not_found_within_strategy_window", entryEpoch: null, entry: null };
  const candle = m1[confirmation.entryIndex];
  if (!candle || candle.epoch < setupEpoch || candle.epoch >= setupEpoch + MAX_CANDIDATE_WAIT_SECONDS) {
    return { status: "no_entry", reason: "candidate_wait_expired", entryEpoch: null, entry: null };
  }
  return { status: "entry", reason: null, entryEpoch: candle.epoch, entry: candle.open };
}

function buildSharedEvents({ marketId, marketName, m1, m5, m15, baselineEvaluator = evaluateCategory }) {
  const events = [];
  const m1Atr = atrSeries(m1, 14);
  const m5Atr = atrSeries(m5, 14);
  const seen = new Set();
  for (let i = MIN_M5_INDEX; i < m5.length - 1; i++) {
    const setupCandle = m5[i];
    const setupEpoch = setupCandle.epoch + TIMEFRAMES.M5;
    const completedM15 = m15.filter(c => c.epoch + TIMEFRAMES.M15 <= setupEpoch);
    const baseline = baselineEvaluator(marketId, marketName || marketId, "SCALP", { M5: m5.slice(0, i + 1), M15: completedM15 }, i);
    if (baseline.state !== "signal") continue;
    const direction = baseline.direction;
    const key = pairKey(marketId, setupEpoch, direction);
    if (seen.has(key)) continue;
    seen.add(key);
    const riskDistance = atr(completedM15, 14) * STOP_ATR_M15;
    const nextM5 = m5[i + 1];
    const breakout = detectBreakout(m5, i, m5Atr[i]);
    const candidate = candidateEntry({ m1, m5, m5Index: i, m1Atr, breakout, setupEpoch, direction });
    const baselineRecord = nextM5 && nextM5.epoch === setupEpoch
      ? { status: "entry", reason: null, entryEpoch: nextM5.epoch, entry: nextM5.open }
      : { status: "no_entry", reason: "baseline_next_m5_unavailable", entryEpoch: null, entry: null };
    events.push({
      pairKey: key, marketId, marketName: marketName || marketId, setupEpoch, direction,
      inputEpochs: { m5Setup: setupCandle.epoch, m15CompletedThrough: completedM15.length ? completedM15[completedM15.length - 1].epoch : null },
      riskDistance, targetR: TARGET_R, horizonSeconds: HORIZON_SECONDS,
      baseline: baselineRecord, candidate
    });
  }
  return events;
}

function replaySharedEvents(events, m1, bounds) {
  const rows = { discovery: [], validation: [], holdout: { status: "sealed_not_evaluated" } };
  const blocked = { baseline: null, candidate: null };
  const counts = Object.fromEntries(["discovery", "validation"].map(k => [k, {
    sharedEligibleEvents: 0, overlapSkipped: { baseline: 0, candidate: 0 },
    purgedAtSplitEnd: 0, purgedAfterEntry: { baseline: 0, candidate: 0 }
  }]));
  for (const event of events.slice().sort((a,b) => a.setupEpoch-b.setupEpoch)) {
    const split = Object.entries(bounds).find(([name,b]) => name !== "holdout" && event.setupEpoch >= b.start && event.setupEpoch < b.end);
    if (!split) continue;
    const [name, range] = split;
    const c = counts[name];
    c.sharedEligibleEvents++;
    if (event.setupEpoch + HORIZON_SECONDS > range.end) {
      c.purgedAtSplitEnd++;
      rows[name].push({ ...event, status: "split_purged" });
      continue;
    }
    const pair = { ...event, baseline: { ...event.baseline }, candidate: { ...event.candidate } };
    for (const method of ["baseline", "candidate"]) {
      const rec = pair[method];
      if (Number.isFinite(blocked[method]) && event.setupEpoch < blocked[method]) {
        c.overlapSkipped[method]++;
        rec.status = "overlap_skipped"; rec.reason = "prior_position_not_resolved";
        continue;
      }
      if (rec.status !== "entry") continue;
      if (rec.entryEpoch + HORIZON_SECONDS > range.end) {
        c.purgedAfterEntry[method]++;
        rec.status = "split_purged_after_entry";
        continue;
      }
      rec.outcome = resolveCommonOutcome({
        m1, entryEpoch: rec.entryEpoch, entry: rec.entry,
        direction: event.direction, riskDistance: event.riskDistance
      });
      rec.status = rec.outcome.status;
      blocked[method] = Number.isFinite(rec.outcome.exitEpoch)
        ? rec.outcome.exitEpoch + TIMEFRAMES.M1 : rec.entryEpoch + HORIZON_SECONDS;
    }
    rows[name].push(pair);
  }
  return { rows, counts };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index), hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function summarizePairedRows(rows) {
  const resolved = rows.filter(r => Number.isFinite(r.baseline?.outcome?.realizedR) && Number.isFinite(r.candidate?.outcome?.realizedR));
  const diffs = resolved.map(r => r.candidate.outcome.realizedR - r.baseline.outcome.realizedR);
  const sorted = diffs.slice().sort((a,b)=>a-b);
  const mean = diffs.length ? diffs.reduce((a,b)=>a+b,0)/diffs.length : null;
  const variance = diffs.length > 1 ? diffs.reduce((a,b)=>a+(b-mean)**2,0)/(diffs.length-1) : null;
  const se = variance === null ? null : Math.sqrt(variance/diffs.length);
  const perMarket = {};
  const clusterMeans = [];
  for (const market of [...new Set(rows.map(r=>r.marketId))]) {
    const ds = resolved.filter(r=>r.marketId===market).map(r=>r.candidate.outcome.realizedR-r.baseline.outcome.realizedR);
    const marketMean = ds.length ? ds.reduce((a,b)=>a+b,0)/ds.length : null;
    perMarket[market] = { pairedResolved: ds.length, meanDifferenceR: marketMean === null ? null : Number(marketMean.toFixed(4)) };
    if (marketMean !== null) clusterMeans.push(marketMean);
  }
  const clusterMean = clusterMeans.length ? clusterMeans.reduce((a,b)=>a+b,0)/clusterMeans.length : null;
  const clusterVariance = clusterMeans.length > 1 ? clusterMeans.reduce((a,b)=>a+(b-clusterMean)**2,0)/(clusterMeans.length-1) : null;
  const clusterSe = clusterVariance === null ? null : Math.sqrt(clusterVariance/clusterMeans.length);
  const tCritical = ({2:4.303,3:3.182,4:2.776,5:2.571,6:2.447,7:2.365,8:2.306,9:2.262})[clusterMeans.length-1] || 1.96;
  return {
    sharedEligibleEvents: rows.length,
    baselineEntries: rows.filter(r=>["target","stopped","time_exit","ambiguous","incomplete_data","data_gap"].includes(r.baseline?.status)).length,
    candidateEntries: rows.filter(r=>["target","stopped","time_exit","ambiguous","incomplete_data","data_gap"].includes(r.candidate?.status)).length,
    pairedResolved: diffs.length,
    meanCandidateMinusBaselineR: mean === null ? null : Number(mean.toFixed(4)),
    medianCandidateMinusBaselineR: diffs.length ? Number(percentile(sorted,0.5).toFixed(4)) : null,
    pairedDifference95PctIntervalUnclustered: se === null ? null : [Number((mean-1.96*se).toFixed(4)),Number((mean+1.96*se).toFixed(4))],
    marketClusterCount: clusterMeans.length,
    marketClusteredMeanDifferenceR: clusterMean === null ? null : Number(clusterMean.toFixed(4)),
    marketClustered95PctInterval: clusterSe === null || clusterMeans.length < 3 ? null : [Number((clusterMean-tCritical*clusterSe).toFixed(4)),Number((clusterMean+tCritical*clusterSe).toFixed(4))],
    pairedClaimStatus: diffs.length >= 50 ? "minimum_pair_count_met_review_uncertainty_and_market_clusters" : "exploratory_inconclusive_under_50_pairs",
    perMarket
  };
}

function buildPairedReplayReport(snapshot, generatedAt = new Date().toISOString()) {
  const markets = {};
  for (const id of MARKETS) {
    const frames = snapshot?.markets?.[id]?.timeframes || {};
    const m1 = latestContinuousSegment(frames.M1 || [], 60);
    const m5 = latestContinuousSegment(frames.M5 || [], 300);
    const m15 = latestContinuousSegment(frames.M15 || [], 900);
    if (m1.length < 500 || m5.length < 65 || m15.length < 65) {
      markets[id] = { status: "insufficient_continuous_history", counts: { M1:m1.length, M5:m5.length, M15:m15.length } };
      continue;
    }
    const start = Math.max(m1[0].epoch,m5[0].epoch,m15[0].epoch);
    const end = Math.min(m1.at(-1).epoch+60,m5.at(-1).epoch+300,m15.at(-1).epoch+900);
    const a1=m1.filter(c=>c.epoch>=start&&c.epoch+60<=end);
    const a5=m5.filter(c=>c.epoch>=start&&c.epoch+300<=end);
    const a15=m15.filter(c=>c.epoch+900<=end);
    const contiguous = (a,step) => a.length>1 && a.every((c,i)=>Number.isFinite(c.epoch)&&c.epoch%step===0&&(i===0||c.epoch-a[i-1].epoch===step));
    if (!contiguous(a1,60)||!contiguous(a5,300)||!contiguous(a15,900)) { markets[id]={status:"noncontinuous_common_window"}; continue; }
    const bounds=splitBounds(start,end);
    if(bounds.validation.start>=bounds.validation.end||bounds.holdout.start>=bounds.holdout.end){markets[id]={status:"window_too_short"};continue;}
    const events=buildSharedEvents({marketId:id,marketName:snapshot.markets[id].marketName||id,m1:a1,m5:a5,m15:a15});
    const replay=replaySharedEvents(events,a1,bounds);
    markets[id]={status:"replayed",commonWindow:{startEpoch:start,endEpoch:end,hours:Number(((end-start)/3600).toFixed(3))},
      sharedEligibleEvents:events.length,counts:replay.counts,
      discovery:summarizePairedRows(replay.rows.discovery),validation:summarizePairedRows(replay.rows.validation),
      discoveryEventAccounting:replay.rows.discovery,validationEventAccounting:replay.rows.validation,
      holdout:{status:"sealed_not_evaluated",reason:"Current historical holdout remains sealed; use a later untouched forward period."}};
  }
  return {version:1,generatedAt,mode:"paired_entry_policy_replay",researchOnly:true,
    contract:"Shared production MTF completed-candle eligibility and direction; baseline next M5 open versus EXP-01 breakout/retest next M1 open within 15 minutes; shared setup-time M15 ATR risk, 2R target and 60-minute M1 outcome horizon.",
    safeguards:{minimumPairedResolved:50,maximumCandidateWaitSeconds:MAX_CANDIDATE_WAIT_SECONDS,holdout:"sealed_not_evaluated",nativeStrategyReplay:"unchanged_and_separate"},
    markets,interpretation:"Paired differences are computed only for same-key events where both policies have resolved outcomes. Fewer than 50 pairs is exploratory and inconclusive; market-level results and market-clustered uncertainty must be reviewed; the unclustered interval is supplemental only. This is not a profitability or promotion verdict."};
}

module.exports={MAX_CANDIDATE_WAIT_SECONDS,pairKey,candidateEntry,buildSharedEvents,replaySharedEvents,summarizePairedRows,buildPairedReplayReport};
