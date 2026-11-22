"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { summarize, keyOf } = require("./market_direction_category_performance");

const ROOT = __dirname;
const PRIOR_EXCLUDED_COHORTS = Object.freeze([
  "JD100 / BUY / SCALP",
  "JD100 / BUY / SHORT_TERM",
  "R_10 / BUY / SHORT_TERM"
]);
const SCENARIOS = Object.freeze([
  { id: "BASELINE_AFTER_BUY_FILTER", marketCategories: [] },
  { id: "R75_SHORT_TERM", marketCategories: ["R_75 / SHORT_TERM"] },
  { id: "BOOM500_SHORT_TERM", marketCategories: ["BOOM500 / SHORT_TERM"] },
  { id: "R75_AND_BOOM500_SHORT_TERM", marketCategories: ["R_75 / SHORT_TERM", "BOOM500 / SHORT_TERM"] }
]);

function isExcluded(record, marketCategories) {
  return PRIOR_EXCLUDED_COHORTS.includes(keyOf(record)) || marketCategories.includes(`${record.marketId || "unknown"} / ${record.category || "unknown"}`);
}

function scenario(records, definition) {
  const baselineRecords = records.filter(record => !PRIOR_EXCLUDED_COHORTS.includes(keyOf(record)));
  const removed = baselineRecords.filter(record => definition.marketCategories.includes(`${record.marketId || "unknown"} / ${record.category || "unknown"}`));
  const kept = baselineRecords.filter(record => !definition.marketCategories.includes(`${record.marketId || "unknown"} / ${record.category || "unknown"}`));
  const all = summarize(kept);
  const delivered = summarize(kept.filter(record => record.telegramStatus === "sent"));
  return {
    id: definition.id,
    priorExcludedCohorts: PRIOR_EXCLUDED_COHORTS,
    excludedMarketCategories: definition.marketCategories,
    removedObservations: removed.length,
    removedDelivered: removed.filter(record => record.telegramStatus === "sent").length,
    removedSummary: summarize(removed),
    allObservations: all,
    telegramDeliveredPopulation: delivered
  };
}

function buildReport(journal, generatedAt = new Date().toISOString()) {
  const records = Array.isArray(journal?.signals) ? journal.signals.filter(Boolean) : [];
  const results = SCENARIOS.map(definition => scenario(records, definition));
  const baseline = results[0];
  return {
    version: 1,
    generatedAt,
    shadowOnly: true,
    methodology: {
      population: "Historical multi-timeframe journal observations; no records are changed.",
      baseline: "The baseline retains the already-tested three weak BUY cohort exclusions.",
      candidate: "Additional filters remove all directions in R_75 SHORT_TERM and/or BOOM500 SHORT_TERM.",
      warning: "Retrospective counterfactual only. The result must be validated on unseen forward-shadow data before any production activation."
    },
    baseline,
    scenarios: results.slice(1).map(result => ({
      ...result,
      deltaVsBaseline: {
        generated: result.allObservations.generated - baseline.allObservations.generated,
        delivered: result.telegramDeliveredPopulation.delivered - baseline.telegramDeliveredPopulation.delivered,
        resolved: result.allObservations.resolved - baseline.allObservations.resolved,
        wins: result.allObservations.wins - baseline.allObservations.wins,
        losses: result.allObservations.losses - baseline.allObservations.losses,
        expired: result.allObservations.expired - baseline.allObservations.expired,
        winRatePoints: Number((result.allObservations.winRate - baseline.allObservations.winRate).toFixed(1)),
        deliveredWinRatePoints: Number((result.telegramDeliveredPopulation.winRate - baseline.telegramDeliveredPopulation.winRate).toFixed(1))
      }
    }))
  };
}

function main() {
  const journal = JSON.parse(fs.readFileSync(path.join(ROOT, "multi_timeframe_journal.json"), "utf8"));
  const report = buildReport(journal);
  fs.writeFileSync(path.join(ROOT, "market_category_filter_shadow_report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ event: "market_category_filter_shadow_report_built", scenarios: report.scenarios.map(s => ({ id: s.id, delta: s.deltaVsBaseline })) }));
  return report;
}

if (require.main === module) main();
module.exports = { PRIOR_EXCLUDED_COHORTS, SCENARIOS, isExcluded, scenario, buildReport, main };
