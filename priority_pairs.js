"use strict";

// Research-priority classification is descriptive, not a claim of strategy profitability.
// R_50's 62.9% is historical directional follow-through across the archived sample,
// not the win rate of the production signal engine or of a validated trading strategy.
const PRIORITY_PAIRS = Object.freeze({
  R_50: Object.freeze({
    tier: "RESEARCH_PRIORITY",
    label: "PRIORITY PAIR — RESEARCH WATCH",
    metricName: "historical directional follow-through",
    metricPct: 62.9,
    sampleBars: 1080,
    asOf: "2026-11-16"
  })
});

function priorityForMarket(marketId) {
  const item = PRIORITY_PAIRS[String(marketId || "")];
  return item ? { ...item } : null;
}

module.exports = { PRIORITY_PAIRS, priorityForMarket };
