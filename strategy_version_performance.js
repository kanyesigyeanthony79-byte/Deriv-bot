"use strict";

// Descriptive reporting only. Does not participate in signal generation or alert routing.
const LEGACY_VERSION = "LEGACY_UNVERSIONED";
const OUTCOMES = ["tp2_hit", "stopped", "stopped_after_tp1", "expired", "pending", "tp1_hit", "ambiguous"];

function outcomeOf(record) {
  const status = String(record.status || "unknown").toLowerCase();
  return OUTCOMES.includes(status) ? status : "other";
}

function summarize(records) {
  const counts = Object.fromEntries(OUTCOMES.map(key => [key, 0]));
  let other = 0;
  for (const record of records) {
    const outcome = outcomeOf(record);
    if (outcome === "other") other++;
    else counts[outcome]++;
  }
  const decisive = counts.tp2_hit + counts.stopped;
  return {
    signals: records.length,
    telegramSent: records.filter(r => r.telegramStatus === "sent").length,
    outcomes: { ...counts, other },
    decisiveTp2Rate: decisive ? Number((counts.tp2_hit / decisive * 100).toFixed(1)) : null,
    decisiveOutcomes: decisive,
    excludedFromDecisiveRate: counts.expired + counts.pending + counts.tp1_hit + counts.stopped_after_tp1 + counts.ambiguous + other
  };
}

function groupBy(records, keyFn) {
  const groups = new Map();
  for (const record of records) {
    const key = String(keyFn(record) ?? "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()].map(([key, rows]) => ({ key, ...summarize(rows) }))
    .sort((a, b) => b.signals - a.signals || a.key.localeCompare(b.key));
}

function buildPerformanceReport(journal, generatedAt = new Date().toISOString()) {
  const all = Array.isArray(journal?.signals) ? journal.signals : [];
  // Historical performance is based on Telegram-delivered signals, matching the production audit.
  const delivered = all.filter(record => record.telegramStatus === "sent");
  const versionOf = record => record.strategyVersion || LEGACY_VERSION;
  const scoreBand = record => {
    const score = Number(record.score);
    if (!Number.isFinite(score)) return "unscored";
    if (score < 65) return "<65";
    if (score < 80) return "65-79";
    if (score < 90) return "80-89";
    return "90-100";
  };
  return {
    version: 1,
    generatedAt,
    methodology: {
      population: "Telegram-delivered journal signals only",
      decisiveTp2Rate: "TP2 hits / (TP2 hits + stopped before TP1); excludes partial, expired, pending, TP1-only and ambiguous outcomes",
      legacyVersion: LEGACY_VERSION,
      note: "Descriptive historical results, not a probability forecast or proof of broker execution."
    },
    totals: {
      journalRecords: all.length,
      telegramDelivered: delivered.length,
      versionTagged: all.filter(r => Boolean(r.strategyVersion)).length,
      legacyUnversioned: all.filter(r => !r.strategyVersion).length
    },
    overall: summarize(delivered),
    byVersion: groupBy(delivered, versionOf),
    byCategory: groupBy(delivered, r => r.category || "unknown"),
    byMarket: groupBy(delivered, r => r.marketId || "unknown"),
    byDirection: groupBy(delivered, r => r.direction || "unknown"),
    byScoreBand: groupBy(delivered, scoreBand),
    byVersionCategory: groupBy(delivered, r => versionOf(r) + " / " + (r.category || "unknown")),
    byVersionMarket: groupBy(delivered, r => versionOf(r) + " / " + (r.marketId || "unknown"))
  };
}

module.exports = { LEGACY_VERSION, outcomeOf, summarize, groupBy, buildPerformanceReport };
