"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const DEFAULT_WINDOWS_MINUTES = [5, 15, 30, 60, 120];
const DEFAULT_SCOPE = "market_category";
const TERMINAL_RESOLVED = new Set(["tp2_hit", "stopped", "stopped_after_tp1"]);

function outcomeOf(record) { return String(record?.status || "").toLowerCase(); }
function groupKey(record, scope = DEFAULT_SCOPE) {
  const market = record?.marketId || record?.market || "unknown";
  if (scope === "market") return String(market);
  if (scope === "market_direction") return `${market}|${record?.direction || "unknown"}`;
  return `${market}|${record?.category || "unknown"}`;
}

function summarize(records, accepted) {
  const sent = accepted.filter(record => record.telegramStatus === "sent").length;
  const resolved = accepted.filter(record => TERMINAL_RESOLVED.has(outcomeOf(record)));
  const wins = resolved.filter(record => outcomeOf(record) === "tp2_hit").length;
  const expired = accepted.filter(record => outcomeOf(record) === "expired").length;
  return {
    population: records.length,
    accepted: accepted.length,
    suppressed: records.length - accepted.length,
    suppressionRate: records.length ? Number(((records.length - accepted.length) / records.length * 100).toFixed(1)) : 0,
    sent: sent,
    deliveryRate: accepted.length ? Number((sent / accepted.length * 100).toFixed(1)) : null,
    overallSentRate: records.length ? Number((sent / records.length * 100).toFixed(1)) : 0,
    expired,
    expiryRate: accepted.length ? Number((expired / accepted.length * 100).toFixed(1)) : null,
    resolved: resolved.length,
    wins,
    losses: resolved.length - wins,
    winRate: resolved.length ? Number((wins / resolved.length * 100).toFixed(1)) : null
  };
}

function simulateCooldown(records, minutes, scope = DEFAULT_SCOPE) {
  const rows = (Array.isArray(records) ? records : [])
    .filter(record => Number.isFinite(Number(record?.entryCandleEpoch)))
    .slice()
    .sort((a, b) => Number(a.entryCandleEpoch) - Number(b.entryCandleEpoch) || String(a.signalId).localeCompare(String(b.signalId)));
  const cooldownSeconds = Number(minutes) * 60;
  const lastAccepted = new Map();
  const accepted = [];
  const suppressed = [];
  for (const record of rows) {
    const key = groupKey(record, scope);
    const epoch = Number(record.entryCandleEpoch);
    const previous = lastAccepted.get(key);
    if (previous === undefined || epoch - previous >= cooldownSeconds) {
      accepted.push(record);
      lastAccepted.set(key, epoch);
    } else {
      suppressed.push({ signalId: record.signalId || null, marketId: record.marketId || null, category: record.category || null, direction: record.direction || null, entryCandleEpoch: epoch, group: key, cooldownMinutes: Number(minutes), reason: "cooldown_shadow_only" });
    }
  }
  return { minutes: Number(minutes), scope, ...summarize(rows, accepted), acceptedSignalIds: accepted.map(record => record.signalId || null), suppressedRecords: suppressed };
}

function buildCooldownShadowReport(journal, generatedAt = new Date().toISOString(), windows = DEFAULT_WINDOWS_MINUTES, scope = DEFAULT_SCOPE) {
  const records = Array.isArray(journal?.signals) ? journal.signals : [];
  const shadowWindow = minutes => {
    const result = simulateCooldown(records, minutes, scope);
    const { acceptedSignalIds, suppressedRecords, ...summary } = result;
    return { ...summary, suppressedSample: suppressedRecords.slice(0, 20) };
  };
  return {
    schemaVersion: 1,
    generatedAt,
    mode: "shadow_only",
    scope,
    methodology: "Chronological candidates are accepted per market and category, then the next candidate inside the cooldown window is counted as shadow-suppressed. Actual delivery and journal statuses are not changed.",
    baseline: summarize(records.filter(record => Number.isFinite(Number(record?.entryCandleEpoch))), records.filter(record => Number.isFinite(Number(record?.entryCandleEpoch)))),
    windows: windows.map(shadowWindow),
    recommendedWindowMinutes: 30
  };
}

function main() {
  const journalPath = path.join(ROOT, "multi_timeframe_journal.json");
  const outputPath = path.join(ROOT, "cooldown_shadow_report.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const report = buildCooldownShadowReport(journal);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ event: "cooldown_shadow_report_built", generatedAt: report.generatedAt, baseline: report.baseline, recommendedWindowMinutes: report.recommendedWindowMinutes }));
  return report;
}

if (require.main === module) main();
module.exports = { DEFAULT_WINDOWS_MINUTES, DEFAULT_SCOPE, groupKey, summarize, simulateCooldown, buildCooldownShadowReport, main };
