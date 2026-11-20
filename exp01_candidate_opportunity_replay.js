"use strict";
// Research-only candidate opportunity replay. Discovery and validation only;
// the holdout is deliberately neither summarized nor evaluated.
const fs = require("node:fs");
const path = require("node:path");
const { TIMEFRAMES, evaluateCategory } = require("./multi_timeframe_engine");
const { detectBreakout, findRetestConfirmation, atrSeries } = require("./breakout_retest_shadow");
const { latestContinuousSegment, splitBounds, resolveCommonOutcome, atr, STOP_ATR_M15, HORIZON_SECONDS, MARKETS } = require("./exp01_matched_replay");
const STOP_ATR = STOP_ATR_M15;

function classifyMtfOverlap(baseline, candidateDirection) {
  if (baseline?.state === "signal") {
    return baseline.direction === candidateDirection ? "mtf_agrees" : "mtf_direction_disagreement";
  }
  return "mtf_" + (baseline?.state || "unknown");
}

function buildCandidateOpportunityReport(snapshot, generatedAt = new Date().toISOString()) {
  const markets = {};
  const pooled = {
    discovery: { breakouts: 0, confirmedRetests: 0, mtf: {}, entries: 0, resolved: 0, outcomes: {}, grossR: 0 },
    validation: { breakouts: 0, confirmedRetests: 0, mtf: {}, entries: 0, resolved: 0, outcomes: {}, grossR: 0 }
  };

  for (const id of MARKETS) {
    const market = snapshot?.markets?.[id];
    const frames = market?.timeframes || {};
    const m1 = latestContinuousSegment(frames.M1 || [], 60);
    const m5 = latestContinuousSegment(frames.M5 || [], 300);
    const m15 = latestContinuousSegment(frames.M15 || [], 900);
    if (m1.length < 500 || m5.length < 65 || m15.length < 65) {
      markets[id] = { status: "insufficient_continuous_history", counts: { M1: m1.length, M5: m5.length, M15: m15.length } };
      continue;
    }
    const start = Math.max(m1[0].epoch, m5[0].epoch, m15[0].epoch);
    const end = Math.min(m1.at(-1).epoch + 60, m5.at(-1).epoch + 300, m15.at(-1).epoch + 900);
    const a1 = m1.filter(c => c.epoch >= start && c.epoch + 60 <= end);
    const a5 = m5.filter(c => c.epoch >= start && c.epoch + 300 <= end);
    const a15 = m15.filter(c => c.epoch + 900 <= end);
    const contiguous = (a, step) => a.length > 1 && a.every((c, i) =>
      Number.isFinite(c.epoch) && c.epoch % step === 0 && (i === 0 || c.epoch - a[i - 1].epoch === step));
    if (!contiguous(a1, 60) || !contiguous(a5, 300) || !contiguous(a15, 900)) {
      markets[id] = { status: "noncontinuous_common_window" };
      continue;
    }
    const bounds = splitBounds(start, end);
    if (bounds.validation.start >= bounds.validation.end) {
      markets[id] = { status: "window_too_short" };
      continue;
    }

    const m1Atr = atrSeries(a1, 14);
    const m5Atr = atrSeries(a5, 14);
    const splitRows = { discovery: [], validation: [] };
    const splitCounts = Object.fromEntries(["discovery", "validation"].map(k => [k, {
      breakoutDetections: 0, confirmedRetests: 0, mtfOverlap: {}, overlapSkipped: 0,
      purgedAtSplitEnd: 0, purgedAfterEntry: 0, entries: 0, resolved: 0, outcomes: {}, grossR: 0
    }]));

    for (let i = 64; i < a5.length - 1; i++) {
      const setupCandle = a5[i];
      const setupEpoch = setupCandle.epoch + TIMEFRAMES.M5;
      const split = Object.entries(bounds).find(([name, b]) =>
        name !== "holdout" && setupEpoch >= b.start && setupEpoch < b.end);
      if (!split) continue; // Includes sealed holdout: do not inspect it.
      const [splitName, range] = split;
      const counts = splitCounts[splitName];
      const breakout = detectBreakout(a5, i, m5Atr[i]);
      if (!breakout) continue;
      counts.breakoutDetections++;

      const direction = breakout.direction === 1 ? "BUY" : "SELL";
      const completedM15 = a15.filter(c => c.epoch + TIMEFRAMES.M15 <= setupEpoch);
      const baseline = evaluateCategory(id, market.marketName || id, "SCALP",
        { M5: a5.slice(0, i + 1), M15: completedM15 }, i);

      const startIndex = a1.findIndex(c => c.epoch === setupEpoch);
      const confirmation = startIndex < 0 ? null : findRetestConfirmation(a1, startIndex, breakout, m1Atr);
      const candidate = confirmation && a1[confirmation.entryIndex]
        ? { entryEpoch: a1[confirmation.entryIndex].epoch, entry: a1[confirmation.entryIndex].open }
        : null;
      const overlap = classifyMtfOverlap(baseline, direction);
      if (candidate) {
        counts.confirmedRetests++;
        counts.mtfOverlap[overlap] = (counts.mtfOverlap[overlap] || 0) + 1;
      }
      const riskDistance = atr(completedM15, 14) * STOP_ATR;
      splitRows[splitName].push({
        setupEpoch, direction, breakoutDetected: true,
        retestConfirmed: !!candidate, candidate,
        mtfState: baseline.state, mtfDirection: baseline.direction || null,
        mtfOverlap: overlap, riskDistance
      });
    }

    for (const splitName of ["discovery", "validation"]) {
      const range = bounds[splitName];
      const counts = splitCounts[splitName];
      let blockedUntil = null;
      for (const row of splitRows[splitName].sort((a, b) => a.setupEpoch - b.setupEpoch)) {
        if (row.setupEpoch + HORIZON_SECONDS > range.end) {
          counts.purgedAtSplitEnd++;
          continue;
        }
        if (Number.isFinite(blockedUntil) && row.setupEpoch < blockedUntil) {
          counts.overlapSkipped++;
          continue;
        }
        if (!row.retestConfirmed || !row.candidate || !(row.riskDistance > 0)) continue;
        if (row.candidate.entryEpoch + HORIZON_SECONDS > range.end) {
          counts.purgedAfterEntry++;
          continue;
        }
        const outcome = resolveCommonOutcome({
          m1: a1, entryEpoch: row.candidate.entryEpoch, entry: row.candidate.entry,
          direction: row.direction, riskDistance: row.riskDistance
        });
        counts.entries++;
        counts.outcomes[outcome.status] = (counts.outcomes[outcome.status] || 0) + 1;
        if (Number.isFinite(outcome.realizedR)) {
          counts.resolved++;
          counts.grossR += outcome.realizedR;
        }
        blockedUntil = Number.isFinite(outcome.exitEpoch)
          ? outcome.exitEpoch + TIMEFRAMES.M1
          : row.candidate.entryEpoch + HORIZON_SECONDS;
      }
      counts.grossR = Number(counts.grossR.toFixed(4));
      counts.meanGrossR = counts.resolved ? Number((counts.grossR / counts.resolved).toFixed(4)) : null;
      counts.meanAfterAssumedCostR = counts.resolved ? Number((counts.meanGrossR - 0.10).toFixed(4)) : null;
      const p = pooled[splitName];
      for (const key of ["breakoutDetections", "confirmedRetests", "entries", "resolved"]) {
        const target = key === "breakoutDetections" ? "breakouts" : key;
        p[target] += counts[key];
      }
      for (const [k, v] of Object.entries(counts.mtfOverlap)) p.mtf[k] = (p.mtf[k] || 0) + v;
      for (const [k, v] of Object.entries(counts.outcomes)) p.outcomes[k] = (p.outcomes[k] || 0) + v;
      p.grossR += counts.grossR;
    }
    markets[id] = {
      status: "replayed",
      commonWindow: { startEpoch: start, endEpoch: end, hours: Number(((end - start) / 3600).toFixed(3)) },
      discovery: splitCounts.discovery,
      validation: splitCounts.validation
    };
  }

  for (const split of ["discovery", "validation"]) {
    const p = pooled[split];
    p.grossR = Number(p.grossR.toFixed(4));
    p.meanGrossR = p.resolved ? Number((p.grossR / p.resolved).toFixed(4)) : null;
    p.meanAfterAssumedCostR = p.resolved ? Number((p.meanGrossR - 0.10).toFixed(4)) : null;
    p.sampleStatus = p.resolved >= 50 ? "minimum_count_met_review_required" : "insufficient_sample_under_50";
  }

  return {
    version: 1, generatedAt, mode: "candidate_opportunity_overlap_replay",
    researchOnly: true, markets, pooled,
    assumptions: {
      candidate: "Frozen M5 breakout beyond prior 12-bar range, followed by M1 retest confirmation; next-M1-open entry.",
      mtf: "Production SCALP eligibility evaluated at the same completed M5 setup candle using completed M15 context and confirmation.",
      commonRisk: "1.25 x completed M15 ATR at setup close.",
      commonTarget: "2R", commonHorizon: "60 minutes, resolved on completed M1 candles.",
      overlap: "One open candidate position per market; later overlapping setups are skipped.",
      costs: "Gross R and a hypothetical 0.10R deduction; not measured broker costs."
    },
    holdout: { status: "sealed_not_evaluated", reason: "This diagnostic intentionally evaluates discovery and validation only." },
    interpretation: "This report measures candidate opportunity frequency and MTF overlap. Small samples are exploratory and cannot support profitability claims or strategy promotion."
  };
}

function main() {
  const dir = process.env.RESEARCH_DATA_DIR || process.cwd();
  const input = path.join(dir, process.env.RESEARCH_MTF_DATA_FILE || "research_multi_timeframe_data.json");
  const output = path.join(dir, "research_exp01_candidate_opportunity_report.json");
  if (!fs.existsSync(input)) throw new Error("Research MTF candle snapshot missing.");
  const report = buildCandidateOpportunityReport(JSON.parse(fs.readFileSync(input, "utf8")));
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({
    event: "exp01_candidate_opportunity_replay_completed",
    discoveryResolved: report.pooled.discovery.resolved,
    validationResolved: report.pooled.validation.resolved,
    holdout: report.holdout.status,
    output
  }));
}
if (require.main === module) main();
module.exports = { classifyMtfOverlap, buildCandidateOpportunityReport };
