"use strict";

// Research-only long-hold policy comparison. No network, alerts, orders or broker stop changes.
const fs = require("node:fs");
const { VARIANTS, evaluateTopDown, confirmedPivots, atr, structure } = require("./top_down_swing_engine");
const SELECTED = {
  R_10: ["H1_CONTROL", "M15_REFINED", "M15_M5_REFINED"],
  R_25: ["H1_CONTROL", "M15_REFINED", "M15_M5_REFINED"],
  R_50: ["H1_CONTROL", "M15_REFINED", "M15_M5_REFINED"]
};
const M5 = 300, H1 = 3600, H4 = 14400, HORIZON = 14 * 86400;
const POLICIES = ["FIXED_2_5R", "PARTIAL_1_5R_BE", "H1_PIVOT_TRAIL", "H4_PIVOT_TRAIL", "H1_STRUCTURE_EXIT"];

function rAt(signal, price) {
  return (signal.direction === "BUY" ? price - signal.entry : signal.entry - price) / signal.riskDistance;
}
function hitStop(signal, candle, stop) {
  return signal.direction === "BUY" ? candle.low <= stop : candle.high >= stop;
}
function targetHit(signal, candle, r) {
  const target = signal.entry + (signal.direction === "BUY" ? 1 : -1) * signal.riskDistance * r;
  return signal.direction === "BUY" ? candle.high >= target : candle.low <= target;
}
function pivotStop(signal, pivots, buffer) {
  const list = signal.direction === "BUY" ? pivots.lows : pivots.highs;
  const p = list.at(-1);
  if (!p) return null;
  return signal.direction === "BUY" ? p.price - buffer : p.price + buffer;
}
function tighterStop(direction, oldStop, nextStop) {
  if (!Number.isFinite(nextStop)) return oldStop;
  return direction === "BUY" ? Math.max(oldStop, nextStop) : Math.min(oldStop, nextStop);
}
function simulatePolicy(signal, frames, policy, horizonSeconds = HORIZON) {
  const entryClose = signal.decisionEpoch ?? signal.entryEpoch;
  const m5 = (frames.M5 || []).filter(c => c.epoch >= entryClose && c.epoch + M5 <= entryClose + horizonSeconds);
  if (!m5.length || m5.at(-1).epoch + M5 < entryClose + horizonSeconds) return { status: "censored", policy };
  const h1 = frames.H1 || [], h4 = frames.H4 || [];
  let stop = signal.stopLoss, partial = false, realised = 0, mfe = 0, mae = 0;
  let exitEpoch = null, exitReason = "horizon_expiry", previousMfe = 0;
  for (const candle of m5) {
    const completedH1 = h1.filter(c => c.epoch + H1 <= candle.epoch && c.epoch + H1 > entryClose);
    const completedH4 = h4.filter(c => c.epoch + H4 <= candle.epoch && c.epoch + H4 > entryClose);
    // Pivot becomes actionable only after its right-hand confirmation candle has closed.
    if (policy === "H1_PIVOT_TRAIL" && previousMfe >= 1 && completedH1.length >= 8) {
      const p = confirmedPivots(completedH1, "H1", candle.epoch);
      const candidate = pivotStop(signal, p, atr(completedH4, 14) * 0.25);
      stop = tighterStop(signal.direction, stop, candidate);
    }
    if (policy === "H4_PIVOT_TRAIL" && previousMfe >= 1 && completedH4.length >= 8) {
      const p = confirmedPivots(completedH4, "H4", candle.epoch);
      const candidate = pivotStop(signal, p, atr(completedH4, 14) * 0.25);
      stop = tighterStop(signal.direction, stop, candidate);
    }
    if (policy === "H1_STRUCTURE_EXIT" && completedH1.length >= 12) {
      const s = structure(completedH1, "H1", candle.epoch);
      if (s.direction !== "NEUTRAL" && s.direction !== signal.direction) {
        realised = rAt(signal, candle.open); exitEpoch = candle.epoch;
        exitReason = "opposing_confirmed_h1_structure"; break;
      }
    }
    const fav = signal.direction === "BUY" ? candle.high : candle.low;
    const adv = signal.direction === "BUY" ? candle.low : candle.high;
    mfe = Math.max(mfe, rAt(signal, fav));
    mae = Math.max(mae, -rAt(signal, adv));
    const stopHit = hitStop(signal, candle, stop);
    const tp1 = targetHit(signal, candle, 1.5), tp2 = targetHit(signal, candle, 2.5);
    if (policy === "FIXED_2_5R") {
      if (stopHit && tp2) return { status: "ambiguous", policy, mfeR: mfe, maeR: mae };
      if (stopHit) { realised = -1; exitReason = "initial_stop"; exitEpoch = candle.epoch; break; }
      if (tp2) { realised = 2.5; exitReason = "fixed_target_2_5R"; exitEpoch = candle.epoch; break; }
    } else if (policy === "PARTIAL_1_5R_BE") {
      if (stopHit && (tp1 || tp2)) return { status: "ambiguous", policy, mfeR: mfe, maeR: mae };
      if (stopHit) {
        realised = partial ? 0.75 : -1;
        exitReason = partial ? "break_even_remainder" : "initial_stop";
        exitEpoch = candle.epoch; break;
      }
      if (tp2 && !partial) return { status: "ambiguous", policy, mfeR: mfe, maeR: mae };
      if (tp2 && partial) { realised = 2; exitReason = "tp2_after_partial"; exitEpoch = candle.epoch; break; }
      if (tp1 && !partial) { partial = true; realised = 0.75; stop = signal.entry; }
    } else {
      if (stopHit) {
        realised = rAt(signal, stop); exitReason = stop === signal.stopLoss ? "initial_stop" : "structure_trailing_stop";
        exitEpoch = candle.epoch; break;
      }
    }
    previousMfe = Math.max(previousMfe, mfe);
    if (candle === m5.at(-1)) {
      const closeR = rAt(signal, candle.close);
      realised = policy === "PARTIAL_1_5R_BE" && partial ? 0.75 + 0.5 * closeR : closeR;
      exitEpoch = candle.epoch + M5;
    }
  }
  return { status: "scored", policy, realisedR: Number(realised.toFixed(4)),
    mfeR: Number(mfe.toFixed(4)), maeR: Number(mae.toFixed(4)),
    durationHours: exitEpoch ? Number(((exitEpoch - entryClose) / 3600).toFixed(2)) : null,
    exitEpoch, exitReason, partialTaken: partial };
}
function summarize(rows) {
  const scored = rows.filter(x => x.status === "scored");
  const avg = key => scored.length ? Number((scored.reduce((s,x)=>s+x[key],0)/scored.length).toFixed(4)) : null;
  const counts = {};
  for (const x of scored) counts[x.exitReason] = (counts[x.exitReason] || 0) + 1;
  return { candidateCount: rows.length, scoredCount: scored.length,
    censoredCount: rows.filter(x=>x.status==="censored").length,
    ambiguousCount: rows.filter(x=>x.status==="ambiguous").length,
    averageR: avg("realisedR"), averageMfeR: avg("mfeR"), averageMaeR: avg("maeR"),
    averageDurationHours: avg("durationHours"), exitReasons: counts };
}
function runLongHoldReplay(snapshot) {
  const report = { version: 1, generatedAt: snapshot.generatedAt || null, horizonDays: 14,
    scope: "selected_markets_long_hold_management_research_only",
    selectedMarkets: Object.keys(SELECTED), policies: POLICIES,
    assumptions: [
      "Entries reuse the existing closed-candle top-down engine; no future candles are visible at entry.",
      "Only complete 14-day M5 forward windows are scored; shorter windows are censored.",
      "H1/H4 pivot trailing levels become actionable only after the right-hand confirmation candle closes and apply from a subsequent M5 candle.",
      "Stop/target collisions inside one M5 candle are marked ambiguous.",
      "No spread, slippage, fees, latency or financing costs are modelled.",
      "This is exploratory historical research, not a profitability claim or live allowlist."
    ], markets: {}, summary: {} };
  for (const [marketId, variants] of Object.entries(SELECTED)) {
    const market = snapshot.markets?.[marketId], frames = market?.timeframes || {};
    const m5 = frames.M5 || [];
    const last = m5.at(-1);
    if (!last) { report.markets[marketId] = { state: "missing_m5" }; continue; }
    const variantRows = {};
    for (const variant of variants) {
      const tf = variant === "H1_CONTROL" ? "H1" : variant === "M15_REFINED" ? "M15" : "M5";
      const seconds = tf === "H1" ? H1 : tf === "M15" ? 900 : M5;
      const decisions = (frames[tf] || []).filter(c => c.epoch + seconds + HORIZON <= last.epoch + M5);
      const seen = new Set(), signals = [];
      for (const bar of decisions) {
        const signal = evaluateTopDown(marketId, frames, bar.epoch + seconds, variant);
        if (signal.state !== "candidate") continue;
        const key = signal.entryEpoch + "|" + signal.direction;
        if (!seen.has(key)) { seen.add(key); signals.push(signal); }
      }
      variantRows[variant] = {};
      for (const policy of POLICIES) {
        const results = signals.map(signal => simulatePolicy(signal, frames, policy));
        variantRows[variant][policy] = summarize(results);
      }
      variantRows[variant].candidateCount = signals.length;
    }
    report.markets[marketId] = { state: "replayed", coverageDays: Number(((last.epoch + M5 - m5[0].epoch) / 86400).toFixed(2)), variants: variantRows };
  }
  for (const variant of VARIANTS) {
    const markets = Object.values(report.markets).filter(m=>m.state==="replayed" && m.variants[variant]);
    if (!markets.length) continue;
    report.summary[variant] = {};
    for (const policy of POLICIES) {
      const parts = markets.map(m=>m.variants[variant][policy]).filter(Boolean);
      const n = parts.reduce((s,x)=>s+x.scoredCount,0);
      const weighted = key => n ? Number((parts.reduce((s,x)=>s+(x[key]||0)*x.scoredCount,0)/n).toFixed(4)) : null;
      report.summary[variant][policy] = { scoredCount:n, averageR:weighted("averageR"),
        averageMfeR:weighted("averageMfeR"), averageMaeR:weighted("averageMaeR"),
        averageDurationHours:weighted("averageDurationHours"),
        ambiguousCount:parts.reduce((s,x)=>s+x.ambiguousCount,0) };
    }
  }
  return report;
}
if (require.main === module) {
  const input = process.argv[2] || "top_down_swing_snapshot.json";
  const output = process.argv[3] || "top_down_swing_long_hold_report.json";
  const report = runLongHoldReplay(JSON.parse(fs.readFileSync(input, "utf8")));
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, summary: report.summary }, null, 2));
}
module.exports = { SELECTED, POLICIES, simulatePolicy, summarize, runLongHoldReplay };
