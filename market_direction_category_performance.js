"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const OUTCOMES = new Set(["tp2_hit", "stopped", "stopped_after_tp1", "expired", "pending", "tp1_hit", "ambiguous", "state_missing", "unverified"]);

function outcomeOf(record) {
  const status = String(record.status || "unknown").toLowerCase();
  return OUTCOMES.has(status) ? status : "other";
}

function deliveryOf(record) {
  const status = String(record.telegramStatus || "untracked").toLowerCase();
  if (status === "missed") {
    if (record.telegramStatusReason === "live_price_too_far_from_entry") return "price_out_of_range";
    if (record.telegramStatusReason === "tp1_already_reached") return "tp1_already_reached";
  }
  if (["failed", "delivery_failed"].includes(status)) return "delivery_failed";
  if (["suppressed", "not_sent"].includes(status)) return "suppressed";
  return status;
}

function summarize(records) {
  const outcomes = { tp2_hit: 0, stopped: 0, stopped_after_tp1: 0, expired: 0, pending: 0, tp1_hit: 0, ambiguous: 0, state_missing: 0, unverified: 0, other: 0 };
  const delivery = { sent: 0, price_out_of_range: 0, tp1_already_reached: 0, stale: 0, quote_unavailable: 0, delivery_failed: 0, suppressed: 0, untracked: 0 };
  for (const record of records) {
    outcomes[outcomeOf(record)]++;
    const deliveryStatus = deliveryOf(record);
    if (deliveryStatus in delivery) delivery[deliveryStatus]++;
    else delivery.untracked++;
  }
  const wins = outcomes.tp2_hit;
  const losses = outcomes.stopped + outcomes.stopped_after_tp1;
  const resolved = wins + losses;
  return {
    generated: records.length,
    delivered: delivery.sent,
    delivery,
    outcomes,
    wins,
    losses,
    resolved,
    winRate: resolved ? Number((wins / resolved * 100).toFixed(1)) : null,
    expired: outcomes.expired,
    unresolved: outcomes.pending + outcomes.tp1_hit,
    excludedFromWinRate: records.length - resolved,
    sufficientResolvedSample: resolved >= 30
  };
}

function keyOf(record) {
  return [record.marketId || record.market || "unknown", record.direction || "unknown", record.category || "unknown"].join(" / ");
}

function groupRows(records) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()]
    .map(([key, rows]) => {
      const [marketId, direction, category] = key.split(" / ");
      return { key, marketId, direction, category, ...summarize(rows) };
    })
    .sort((a, b) => b.generated - a.generated || a.key.localeCompare(b.key));
}

function dateInUganda(epoch) {
  if (!Number.isFinite(Number(epoch))) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Number(epoch) * 1000));
}

function buildReport(journal, generatedAt = new Date().toISOString()) {
  const records = Array.isArray(journal?.signals) ? journal.signals.filter(Boolean) : [];
  const dates = records.map(r => dateInUganda(r.entryCandleEpoch ?? r.createdEpoch)).filter(Boolean).sort();
  const all = summarize(records);
  return {
    version: 1,
    generatedAt,
    timezone: "Africa/Kampala",
    methodology: {
      population: "All recoverable multi-timeframe journal observations, including delivered, suppressed, stale, quote-unavailable and untracked records.",
      winRate: "TP2 hits / (TP2 hits + stopped or stopped-after-TP1); expired, pending, TP1-only, ambiguous and unverified observations are excluded.",
      warning: "Descriptive historical analysis only. A cohort with fewer than 30 resolved outcomes is insufficient for a strategy decision; no routing behavior is changed."
    },
    coverage: { records: records.length, firstUgandaDate: dates[0] || null, lastUgandaDate: dates.at(-1) || null },
    overall: all,
    cohorts: groupRows(records)
  };
}

function main() {
  const input = JSON.parse(fs.readFileSync(path.join(ROOT, "multi_timeframe_journal.json"), "utf8"));
  const report = buildReport(input);
  fs.writeFileSync(path.join(ROOT, "market_direction_category_performance_report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ event: "market_direction_category_report_built", coverage: report.coverage, cohorts: report.cohorts.length }));
  return report;
}

if (require.main === module) main();
module.exports = { outcomeOf, deliveryOf, summarize, keyOf, groupRows, buildReport, main };
