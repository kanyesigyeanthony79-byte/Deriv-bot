"use strict";

// Deterministic historical comparison for a top_down_swing_snapshot.json artifact.
const fs = require("node:fs");
const { VARIANTS, evaluateTopDown, managementAdvisories } = require("./top_down_swing_engine");
const M5_SECONDS = 300, MAX_AGE = 7 * 86400;
function signedR(signal, price) {
  return (signal.direction === "BUY" ? price - signal.entry : signal.entry - price) / signal.riskDistance;
}
function simulateOutcome(signal, m5, policy = "fixed") {
  const entryCloseEpoch = Number.isFinite(signal.decisionEpoch) ? signal.decisionEpoch : signal.entryEpoch;
  const future = (m5 || []).filter(c => c.epoch >= entryCloseEpoch && c.epoch + M5_SECONDS <= entryCloseEpoch + MAX_AGE);
  if (!future.length || future[future.length - 1].epoch + M5_SECONDS < entryCloseEpoch + MAX_AGE)
    return { status: "censored", policy };
  const tp1 = signal.entry + (signal.direction === "BUY" ? 1 : -1) * signal.riskDistance * 1.5;
  const tp2 = signal.entry + (signal.direction === "BUY" ? 1 : -1) * signal.riskDistance * 2.5;
  let partial = false, realisedR = 0, exitEpoch = null, status = "expired";
  let mfe = 0, mae = 0;
  for (const candle of future) {
    const favourable = signal.direction === "BUY" ? candle.high : candle.low;
    const adverse = signal.direction === "BUY" ? candle.low : candle.high;
    mfe = Math.max(mfe, signedR(signal, favourable));
    mae = Math.max(mae, -signedR(signal, adverse));
    const stop = signal.direction === "BUY" ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;
    const one = signal.direction === "BUY" ? candle.high >= tp1 : candle.low <= tp1;
    const two = signal.direction === "BUY" ? candle.high >= tp2 : candle.low <= tp2;
    if (policy === "fixed") {
      if (stop && two) { status = "ambiguous"; exitEpoch = candle.epoch; break; }
      if (stop) { status = "stopped"; realisedR = -1; exitEpoch = candle.epoch; break; }
      if (two) { status = "tp2_hit"; realisedR = 2.5; exitEpoch = candle.epoch; break; }
    } else {
      if (stop && (one || two)) { status = "ambiguous"; exitEpoch = candle.epoch; break; }
      if (stop) {
        status = partial ? "stopped_after_tp1" : "stopped";
        realisedR = partial ? 0.25 : -1;
        exitEpoch = candle.epoch; break;
      }
      if (two && !partial) { status = "ambiguous"; exitEpoch = candle.epoch; break; }
      if (two && partial) { status = "tp2_hit"; realisedR = 2; exitEpoch = candle.epoch; break; }
      if (one && !partial) { partial = true; realisedR = 0.75; }
    }
    if (candle === future[future.length - 1]) {
      status = "expired"; exitEpoch = candle.epoch;
      const closeR = signedR(signal, candle.close);
      realisedR = policy === "partial" && partial ? 0.75 + 0.5 * closeR : closeR;
    }
  }
  return { status, policy, realisedR: Number(realisedR.toFixed(4)), mfeR: Number(mfe.toFixed(4)),
    maeR: Number(mae.toFixed(4)), durationHours: exitEpoch ? (exitEpoch - entryCloseEpoch) / 3600 : null,
    exitEpoch, partialTaken: partial };
}
function thesisKey(signal) {
  const highs = signal.h4.pivots.highs.slice(-2).map(p => p.epoch).join(",");
  const lows = signal.h4.pivots.lows.slice(-2).map(p => p.epoch).join(",");
  return [signal.marketId, signal.direction, highs, lows].join("|");
}
function runReplay(snapshot, options = {}) {
  const maxAge = Number.isFinite(options.maxAgeSeconds) ? options.maxAgeSeconds : MAX_AGE;
  if (maxAge !== MAX_AGE) throw new Error("This initial comparison is fixed to a seven-day outcome horizon.");
  const report = { version: 1, generatedAt: snapshot.generatedAt || null, horizonDays: 7,
    assumptions: ["Entry is filled at the completed signal candle close.", "M5 OHLC is used for outcome checks; same-candle stop/target collisions are ambiguous.",
      "No spread, slippage, fees or execution latency are modelled.", "Only entries with a complete seven-day forward window are scored."],
    markets: {}, summary: {} };
  for (const [marketId, market] of Object.entries(snapshot.markets || {})) {
    const frames = market.timeframes || {}, m5 = frames.M5 || [];
    if (m5.length < 20) { report.markets[marketId] = { state: "insufficient_m5_history" }; continue; }
    const latestClose = m5[m5.length - 1].epoch + M5_SECONDS;
    const eligibleDecisions = m5.filter(c => c.epoch + M5_SECONDS + MAX_AGE <= latestClose);
    const byVariant = Object.fromEntries(VARIANTS.map(v => [v, new Map()]));
    for (const bar of eligibleDecisions) {
      const decision = bar.epoch + M5_SECONDS;
      for (const variant of VARIANTS) {
        const signal = evaluateTopDown(marketId, frames, decision, variant);
        if (signal.state !== "candidate") continue;
        const key = signal.entryEpoch + "|" + signal.direction;
        if (!byVariant[variant].has(key)) byVariant[variant].set(key, signal);
      }
    }
    const candidates = {};
    for (const variant of VARIANTS) {
      const signals = [...byVariant[variant].values()];
      const results = signals.map(signal => {
        const fixed = simulateOutcome(signal, m5, "fixed");
        const partial = simulateOutcome(signal, m5, "partial");
        const advisoryTypes = new Set();
        const h1 = frames.H1 || [], h4 = frames.H4 || [];
        for (const candle of h1) {
          const at = candle.epoch + 3600;
          if (at <= (signal.decisionEpoch ?? signal.entryEpoch) || at > (signal.decisionEpoch ?? signal.entryEpoch) + MAX_AGE) continue;
          for (const event of managementAdvisories(signal, { H1: h1, H4: h4 }, at)) advisoryTypes.add(event.type);
        }
        return { signal, fixed, partial, advisoryTypes: [...advisoryTypes] };
      });
      const scored = results.filter(r => r.fixed.status !== "censored");
      const avg = values => values.length ? Number((values.reduce((a,b)=>a+b,0)/values.length).toFixed(4)) : null;
      const median = values => {
        if (!values.length) return null;
        const sorted = [...values].sort((a,b)=>a-b), mid = Math.floor(sorted.length / 2);
        return Number((sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2).toFixed(4));
      };
      const alignmentBreakdown = Object.fromEntries(["aligned", "counter_trend", "neutral"].map(alignment => {
        const group = results.filter(r => r.signal.d1Alignment === alignment);
        const groupScored = group.filter(r => r.fixed.status !== "censored");
        return [alignment, {
          candidateCount: group.length,
          scoredCount: groupScored.length,
          averageFixedR: avg(groupScored.map(r => r.fixed.realisedR)),
          outcomesFixed: Object.fromEntries(["tp2_hit","stopped","ambiguous","expired"].map(status =>
            [status, groupScored.filter(r => r.fixed.status === status).length]))
        }];
      }));
      candidates[variant] = {
        candidateCount: signals.length, scoredCount: scored.length,
        d1Alignment: alignmentBreakdown,
        censoredCount: results.length - scored.length,
        outcomesFixed: Object.fromEntries(["tp2_hit","stopped","ambiguous","expired"].map(s => [s, scored.filter(r => r.fixed.status === s).length])),
        outcomesPartial: Object.fromEntries(["tp2_hit","stopped","stopped_after_tp1","ambiguous","expired"].map(s => [s, scored.filter(r => r.partial.status === s).length])),
        averageFixedR: avg(scored.map(r => r.fixed.realisedR)),
        averagePartialR: avg(scored.map(r => r.partial.realisedR)),
        medianMfeR: median(scored.map(r => r.fixed.mfeR)),
        averageMaeR: avg(scored.map(r => r.fixed.maeR)),
        advisoryCounts: Object.fromEntries(["HOLD_STRUCTURE_INTACT","BREAK_EVEN_REVIEW","TRAILING_PROTECTION_REVIEW",
          "PARTIAL_PROFIT_REVIEW","STRUCTURE_DETERIORATION_WARNING","EARLY_LOSS_REVIEW"].map(type =>
          [type, results.filter(r => r.advisoryTypes.includes(type)).length]))
      };
    }
    const thesisSets = VARIANTS.map(v => new Set([...byVariant[v].values()].map(thesisKey)));
    const shared = [...thesisSets[0]].filter(k => thesisSets.every(s => s.has(k))).length;
    const coverageSeconds = m5[m5.length - 1].epoch + M5_SECONDS - (m5[0].epoch + M5_SECONDS);
    report.markets[marketId] = { state: eligibleDecisions.length ? "replayed" : "insufficient_forward_coverage",
      firstM5Epoch: m5[0].epoch, lastM5Epoch: m5[m5.length - 1].epoch,
      coverageDays: Number((coverageSeconds / 86400).toFixed(2)), requiredCoverageDays: 7,
      eligibleDecisionCount: eligibleDecisions.length,
      sharedThesisCountAcrossAllVariants: shared, variants: candidates };
  }
  for (const variant of VARIANTS) {
    const rows = Object.values(report.markets).filter(m => m.state === "replayed").map(m => m.variants[variant]);
    report.summary[variant] = {
      candidateCount: rows.reduce((n,r)=>n+r.candidateCount,0),
      scoredCount: rows.reduce((n,r)=>n+r.scoredCount,0),
      averageFixedR: (() => {
        const n = rows.reduce((sum, r) => sum + r.scoredCount, 0);
        const total = rows.reduce((sum, r) => sum + (r.averageFixedR === null ? 0 : r.averageFixedR * r.scoredCount), 0);
        return n ? Number((total / n).toFixed(4)) : null;
      })(),
      outcomesFixed: Object.fromEntries(["tp2_hit","stopped","ambiguous","expired"].map(status =>
        [status, rows.reduce((sum, r) => sum + r.outcomesFixed[status], 0)])),
      marketsIncluded: rows.length
    };
  }
  return report;
}
if (require.main === module) {
  const input = process.argv[2] || "top_down_swing_snapshot.json";
  const output = process.argv[3] || "top_down_swing_replay_report.json";
  const snapshot = JSON.parse(fs.readFileSync(input, "utf8"));
  const report = runReplay(snapshot);
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, summary: report.summary }, null, 2));
}
module.exports = { simulateOutcome, thesisKey, runReplay };
