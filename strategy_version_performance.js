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

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return Number((sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2).toFixed(1));
}

function expiryAnalysis(records) {
  const expired = records.filter(record => outcomeOf(record) === "expired");
  const excursion = record => {
    const risk = Number(record.riskDistance);
    const favourable = Number(record.maxFavourablePoints);
    return Number.isFinite(risk) && risk > 0 && Number.isFinite(favourable)
      ? favourable / risk : null;
  };
  const band = record => {
    const r = excursion(record);
    if (r === null) return "unavailable";
    if (r < 0.5) return "<0.5R";
    if (r < 1) return "0.5-<1R";
    if (r < 1.5) return "1-<1.5R";
    if (r < 2) return "1.5-<2R";
    return "2R+";
  };
  const delayRows = expired.filter(r => r.expiryDelaySeconds !== null && r.expiryDelaySeconds !== undefined && Number.isFinite(Number(r.expiryDelaySeconds)));
  const bands = ["<0.5R", "0.5-<1R", "1-<1.5R", "1.5-<2R", "2R+", "unavailable"];
  const byCategory = groupBy(expired, r => r.category || "unknown").map(row => ({
    key: row.key, signals: row.signals,
    tp1Reached: expired.filter(r => (r.category || "unknown") === row.key && Boolean(r.tp1Hit)).length,
    favourableAtLeast1R: expired.filter(r => (r.category || "unknown") === row.key && (excursion(r) ?? -1) >= 1).length
  }));
  const byMarket = groupBy(expired, r => r.marketId || "unknown").map(row => ({
    key: row.key, signals: row.signals,
    tp1Reached: expired.filter(r => (r.marketId || "unknown") === row.key && Boolean(r.tp1Hit)).length,
    favourableAtLeast1R: expired.filter(r => (r.marketId || "unknown") === row.key && (excursion(r) ?? -1) >= 1).length
  }));
  return {
    expiredSignals: expired.length,
    tp1Reached: expired.filter(r => Boolean(r.tp1Hit)).length,
    withIntendedExpiryTimestamp: expired.filter(r => r.intendedExpiryEpoch !== null && r.intendedExpiryEpoch !== undefined && Number.isFinite(Number(r.intendedExpiryEpoch))).length,
    withActualExpiryTimestamp: expired.filter(r => r.expiredEpoch !== null && r.expiredEpoch !== undefined && Number.isFinite(Number(r.expiredEpoch))).length,
    withMeasuredExpiryDelay: delayRows.length,
    medianExpiryDelaySeconds: median(delayRows.map(r => Number(r.expiryDelaySeconds))),
    expiryDelayOver15Minutes: delayRows.filter(r => Number(r.expiryDelaySeconds) > 900).length,
    expiryDelayOver60Minutes: delayRows.filter(r => Number(r.expiryDelaySeconds) > 3600).length,
    favourableExcursionBands: bands.map(key => ({ key, signals: expired.filter(r => band(r) === key).length })),
    byCategory, byMarket,
    note: "Favourable excursion is maximum recorded candle movement divided by risk distance; it is not proof of execution or realised profit. Missing historical timestamps remain missing and are not reconstructed."
  };
}

function buildReviewComparison(delivered, reviewRecords = []) {
  const byId = new Map((Array.isArray(reviewRecords) ? reviewRecords : []).map(row => [row.signalId, row]));
  const groups = new Map();
  let matchedSignals = 0, unmatchedSignals = 0, terminalReviewLevels = 0;
  for (const signal of delivered) {
    const row = byId.get(signal.signalId);
    if (!row || !row.review || !row.review.status) { unmatchedSignals++; continue; }
    matchedSignals++;
    const originalOutcome = outcomeOf(signal), advisoryStatus = row.review.status;
    const key = originalOutcome + " / " + advisoryStatus;
    groups.set(key, (groups.get(key) || 0) + 1);
    if (["STOP_LEVEL_TOUCHED", "STOP_AFTER_TP1", "TP2_LEVEL_TOUCHED", "AMBIGUOUS_CANDLE"].includes(advisoryStatus)) terminalReviewLevels++;
  }
  return {
    matchedSignals, unmatchedSignals, terminalReviewLevels,
    byOriginalOutcomeAndAdvisoryStatus: [...groups.entries()].map(([key, signals]) => ({ key, signals }))
      .sort((a, b) => b.signals - a.signals || a.key.localeCompare(b.key)),
    note: "Original journal outcome and current candle-based advisory review are separate observations. Advisory statuses never overwrite journal outcomes and do not prove broker execution."
  };
}

function buildPerformanceReport(journal, generatedAt = new Date().toISOString(), reviewRecords = []) {
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
    expiryAnalysis: expiryAnalysis(delivered),
    byVersion: groupBy(delivered, versionOf),
    byCategory: groupBy(delivered, r => r.category || "unknown"),
    byMarket: groupBy(delivered, r => r.marketId || "unknown"),
    byDirection: groupBy(delivered, r => r.direction || "unknown"),
    byScoreBand: groupBy(delivered, scoreBand),
    byVersionCategory: groupBy(delivered, r => versionOf(r) + " / " + (r.category || "unknown")),
    byVersionMarket: groupBy(delivered, r => versionOf(r) + " / " + (r.marketId || "unknown"))
  };
}

module.exports = { LEGACY_VERSION, outcomeOf, summarize, groupBy, expiryAnalysis, buildReviewComparison, buildPerformanceReport };
