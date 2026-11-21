"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { summarize, keyOf } = require("./market_direction_category_performance");

const ROOT = __dirname;
const CANDIDATE_FILTER = "BUY_WEAK_COHORTS_V1";
const EXCLUDED_COHORTS = Object.freeze([
  "JD100 / BUY / SCALP",
  "JD100 / BUY / SHORT_TERM",
  "R_10 / BUY / SHORT_TERM"
]);

function compare(records, excludedKeys = []) {
  const excluded = new Set(excludedKeys);
  const kept = records.filter(record => !excluded.has(keyOf(record)));
  const removed = records.filter(record => excluded.has(keyOf(record)));
  const all = summarize(kept);
  const delivered = summarize(kept.filter(record => record.telegramStatus === "sent"));
  return {
    filter: excludedKeys.length ? CANDIDATE_FILTER : "NO_FILTER",
    excludedCohorts: excludedKeys,
    removedObservations: removed.length,
    removedDelivered: removed.filter(record => record.telegramStatus === "sent").length,
    allObservations: all,
    telegramDeliveredPopulation: delivered
  };
}

function buildReport(journal, generatedAt = new Date().toISOString()) {
  const records = Array.isArray(journal?.signals) ? journal.signals.filter(Boolean) : [];
  const baseline = compare(records);
  const candidate = compare(records, EXCLUDED_COHORTS);
  return {
    version: 1,
    generatedAt,
    shadowOnly: true,
    methodology: {
      population: "Historical multi-timeframe journal observations; no records are changed.",
      candidate: "Exclude recurring BUY cohorts with zero historical wins and at least 20 generated observations: JD100 SCALP, JD100 SHORT_TERM and R_10 SHORT_TERM.",
      warning: "This is a retrospective counterfactual, not proof that future filtering will improve results. All excluded cohorts have fewer than 30 resolved outcomes."
    },
    baseline,
    candidate,
    deltas: {
      generated: candidate.allObservations.generated - baseline.allObservations.generated,
      delivered: candidate.telegramDeliveredPopulation.delivered - baseline.telegramDeliveredPopulation.delivered,
      resolved: candidate.allObservations.resolved - baseline.allObservations.resolved,
      wins: candidate.allObservations.wins - baseline.allObservations.wins,
      losses: candidate.allObservations.losses - baseline.allObservations.losses,
      expired: candidate.allObservations.expired - baseline.allObservations.expired,
      winRatePoints: candidate.allObservations.winRate === null || baseline.allObservations.winRate === null
        ? null : Number((candidate.allObservations.winRate - baseline.allObservations.winRate).toFixed(1)),
      deliveredWinRatePoints: candidate.telegramDeliveredPopulation.winRate === null || baseline.telegramDeliveredPopulation.winRate === null
        ? null : Number((candidate.telegramDeliveredPopulation.winRate - baseline.telegramDeliveredPopulation.winRate).toFixed(1))
    }
  };
}

function main() {
  const journal = JSON.parse(fs.readFileSync(path.join(ROOT, "multi_timeframe_journal.json"), "utf8"));
  const report = buildReport(journal);
  fs.writeFileSync(path.join(ROOT, "weak_cohort_filter_shadow_report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ event: "weak_cohort_filter_shadow_report_built", deltas: report.deltas, excluded: report.candidate.excludedCohorts }));
  return report;
}

if (require.main === module) main();
module.exports = { CANDIDATE_FILTER, EXCLUDED_COHORTS, compare, buildReport, main };
