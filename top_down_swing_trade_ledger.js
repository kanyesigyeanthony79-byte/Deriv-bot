"use strict";

// Trade-by-trade audit companion for the long-hold research replay.
// Research only: reads a saved candle snapshot and never places orders.
const fs = require("node:fs");
const { SELECTED, POLICIES, simulatePolicy } = require("./top_down_swing_long_hold_replay");
const { evaluateTopDown, TF } = require("./top_down_swing_engine");
const HORIZON = 14 * 86400;

function iso(epoch) {
  return Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : null;
}
function lastPivot(structure, side) {
  const list = structure?.pivots?.[side] || [];
  const p = list.at(-1);
  return p ? { price: p.price, epoch: p.epoch, confirmedEpoch: p.confirmedEpoch } : null;
}
function tradeRow(marketId, variant, policy, signal, result) {
  return {
    market: marketId,
    variant,
    policy,
    direction: signal.direction,
    entryTimeframe: signal.entryTimeframe,
    entryCandleEpoch: signal.entryEpoch,
    decisionEpoch: signal.decisionEpoch,
    entryTimeUtc: iso(signal.decisionEpoch),
    entryPrice: signal.entry,
    initialStop: signal.stopLoss,
    structuralInvalidation: signal.structuralInvalidation,
    riskDistance: signal.riskDistance,
    riskInAtr: Number.isFinite(signal.riskInAtr) ? Number(signal.riskInAtr.toFixed(4)) : null,
    trigger: signal.trigger,
    d1Context: signal.d1Context,
    d1Alignment: signal.d1Alignment,
    d1State: signal.d1?.state || null,
    h4State: signal.h4?.state || null,
    h4Direction: signal.h4?.direction || null,
    h4LatestHighPivot: lastPivot(signal.h4, "highs"),
    h4LatestLowPivot: lastPivot(signal.h4, "lows"),
    h1State: signal.h1?.state || null,
    h1Direction: signal.h1?.direction || null,
    status: result.status,
    realisedR: result.realisedR ?? null,
    mfeR: result.mfeR ?? null,
    maeR: result.maeR ?? null,
    durationHours: result.durationHours ?? null,
    exitTimeUtc: iso(result.exitEpoch),
    exitReason: result.exitReason || null,
    partialTaken: result.partialTaken ?? false
  };
}
function summarizeLedger(rows) {
  const groups = {};
  for (const row of rows) {
    const key = [row.market, row.variant, row.policy].join("|");
    const g = groups[key] ||= { market: row.market, variant: row.variant, policy: row.policy,
      candidates: 0, scored: 0, censored: 0, ambiguous: 0, r: 0, mfe: 0, mae: 0, duration: 0, exits: {} };
    g.candidates++;
    if (row.status === "censored") { g.censored++; continue; }
    if (row.status === "ambiguous") { g.ambiguous++; continue; }
    if (row.status !== "scored") continue;
    g.scored++;
    g.r += row.realisedR || 0;
    g.mfe += row.mfeR || 0;
    g.mae += row.maeR || 0;
    g.duration += row.durationHours || 0;
    g.exits[row.exitReason] = (g.exits[row.exitReason] || 0) + 1;
  }
  return Object.values(groups).map(g => ({
    market:g.market, variant:g.variant, policy:g.policy,
    candidateCount:g.candidates, scoredCount:g.scored, censoredCount:g.censored,
    ambiguousCount:g.ambiguous,
    averageR:g.scored ? Number((g.r/g.scored).toFixed(4)) : null,
    averageMfeR:g.scored ? Number((g.mfe/g.scored).toFixed(4)) : null,
    averageMaeR:g.scored ? Number((g.mae/g.scored).toFixed(4)) : null,
    averageDurationHours:g.scored ? Number((g.duration/g.scored).toFixed(2)) : null,
    exitReasons:g.exits
  }));
}
function buildTradeLedger(snapshot) {
  const rows = [];
  for (const [marketId, variants] of Object.entries(SELECTED)) {
    const frames = snapshot.markets?.[marketId]?.timeframes || {};
    const m5 = frames.M5 || [];
    const last = m5.at(-1);
    if (!last) continue;
    for (const variant of variants) {
      const tf = variant === "H1_CONTROL" ? "H1" : variant === "M15_REFINED" ? "M15" : "M5";
      const seconds = TF[tf];
      const eligible = (frames[tf] || []).filter(c => c.epoch + seconds + HORIZON <= last.epoch + TF.M5);
      const seen = new Set();
      for (const bar of eligible) {
        const signal = evaluateTopDown(marketId, frames, bar.epoch + seconds, variant);
        if (signal.state !== "candidate") continue;
        const identity = signal.entryEpoch + "|" + signal.direction;
        if (seen.has(identity)) continue;
        seen.add(identity);
        for (const policy of POLICIES) {
          const result = simulatePolicy(signal, frames, policy);
          rows.push(tradeRow(marketId, variant, policy, signal, result));
        }
      }
    }
  }
  return { version:1, generatedAt:new Date().toISOString(), horizonDays:14,
    scope:"research_only_trade_by_trade_audit", assumptions:[
      "Rows replay the same entry decisions and management-policy simulator as PR #26.",
      "Only complete 14-day M5 forward windows are scored; censored and ambiguous rows remain visible.",
      "D1/H4/H1 context is recorded as known at the entry decision close; no future context is used.",
      "No spread, slippage, fees, latency or financing costs are modelled."
    ], summary:summarizeLedger(rows), trades:rows };
}
if (require.main === module) {
  const input = process.argv[2] || "top_down_swing_snapshot.json";
  const output = process.argv[3] || "top_down_swing_trade_ledger.json";
  const ledger = buildTradeLedger(JSON.parse(fs.readFileSync(input, "utf8")));
  fs.writeFileSync(output, JSON.stringify(ledger, null, 2) + "\n");
  console.log(JSON.stringify({ output, rows:ledger.trades.length, groups:ledger.summary.length }, null, 2));
}
module.exports = { iso, tradeRow, summarizeLedger, buildTradeLedger };
