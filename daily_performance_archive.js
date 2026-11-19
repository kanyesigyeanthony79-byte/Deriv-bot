"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const MARKETS = [
  ["R_10", "Volatility 10 Index"], ["R_25", "Volatility 25 Index"],
  ["R_50", "Volatility 50 Index"], ["R_75", "Volatility 75 Index"],
  ["JD75", "Jump 75 Index"], ["JD100", "Jump 100 Index"],
  ["frxXAUUSD", "Gold/USD"], ["CRASH500", "Crash 500 Index"], ["BOOM500", "Boom 500 Index"]
];
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
function dateInUganda(epoch) {
  if (epoch === null || epoch === undefined || epoch === "" || !Number.isFinite(Number(epoch))) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Number(epoch) * 1000));
}
function legacyDate(r) {
  if (typeof r.localDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.localDate)) return r.localDate;
  if (r.createdAt && Number.isFinite(Date.parse(r.createdAt))) return dateInUganda(Date.parse(r.createdAt) / 1000);
  if (r.candleEpoch !== null && r.candleEpoch !== undefined && Number.isFinite(Number(r.candleEpoch))) return dateInUganda(r.candleEpoch);
  return null;
}
function mtfDate(r) { return dateInUganda(r.entryCandleEpoch ?? r.createdEpoch); }
function compact(r, source, day) {
  const legacy = source === "legacy_15m";
  return {
    signalId: r.signalId || null, source, date: day,
    createdAt: r.createdAt || (r.entryCandleEpoch !== null && r.entryCandleEpoch !== undefined && Number.isFinite(Number(r.entryCandleEpoch)) ? new Date(Number(r.entryCandleEpoch) * 1000).toISOString() : null),
    market: r.market || r.marketId || "unknown", marketId: r.marketId || null,
    category: r.category || (legacy ? "LEGACY_15M" : "unknown"), direction: r.direction || null,
    entry: r.entry ?? null, stopLoss: r.stopLoss ?? null, tp1: r.tp1 ?? null, tp2: r.tp2 ?? null,
    strategyVersion: r.strategyVersion || (legacy ? "LEGACY_UNVERSIONED" : null),
    telegramStatus: legacy ? (r.status === "sent" ? "sent" : r.status || "untracked") : r.telegramStatus || "untracked",
    outcome: legacy ? (r.finalOutcome || (r.status === "sent" ? "pending" : r.status || "unverified")) : r.status || "unknown",
    reason: r.statusReason || r.deliveryError || r.error || null,
    tp1Hit: Boolean(r.tp1Hit), score: r.score ?? null
  };
}
function summarize(records, source) {
  const status = r => String(r.outcome || "").toLowerCase();
  const count = fn => records.filter(fn).length;
  const wins = count(r => ["tp2", "tp2_hit"].includes(status(r)));
  const losses = count(r => ["sl", "sl_after_tp1", "stopped", "stopped_after_tp1"].includes(status(r)));
  const resolved = wins + losses;
  return {
    source, generated: records.length, delivered: count(r => r.telegramStatus === "sent"),
    missed: count(r => ["suppressed", "stale", "delivery_failed", "failed", "not_sent"].includes(status(r)) ||
      ["delivery_failed", "failed", "not_sent"].includes(r.telegramStatus)),
    tp1: count(r => r.tp1Hit || ["tp1_hit", "stopped_after_tp1", "sl_after_tp1"].includes(status(r))),
    wins, losses, resolved, winRate: resolved ? Number((wins / resolved * 100).toFixed(1)) : null,
    expired: count(r => status(r) === "expired"), ambiguous: count(r => status(r) === "ambiguous"),
    unresolved: count(r => ["pending", "tp1_hit", "unknown"].includes(status(r))),
    unverified: count(r => ["unverified", "state_missing"].includes(status(r))), signals: records
  };
}
function buildDailyPerformanceArchive(legacyJournal, mtfJournal, generatedAt = new Date().toISOString()) {
  const legacy = Array.isArray(legacyJournal?.signals) ? legacyJournal.signals : [];
  const mtf = Array.isArray(mtfJournal?.signals) ? mtfJournal.signals : [];
  const saved = legacyJournal?.dailyReports && typeof legacyJournal.dailyReports === "object" ? legacyJournal.dailyReports : {};
  const map = new Map();
  const ensure = date => { if (!map.has(date)) map.set(date, { date, legacy: [], mtf: [], saved: null }); return map.get(date); };
  for (const r of legacy) { const date = legacyDate(r); if (date) ensure(date).legacy.push(compact(r, "legacy_15m", date)); }
  for (const r of mtf) { const date = mtfDate(r); if (date) ensure(date).mtf.push(compact(r, "multi_timeframe", date)); }
  for (const [date, report] of Object.entries(saved)) if (/^\d{4}-\d{2}-\d{2}$/.test(date)) ensure(date).saved = report;
  const days = [...map.values()].sort((a,b) => b.date.localeCompare(a.date)).map(d => {
    const l = summarize(d.legacy, "legacy_15m"), m = summarize(d.mtf, "multi_timeframe");
    const confirmed = d.saved?.delivered === true && d.saved?.telegramConfirmed !== false;
    return {
      date: d.date, recordStatus: confirmed ? "verified_daily_report" : "reconstructed_from_journals",
      reportDelivery: confirmed ? "telegram_confirmed" : d.saved ? "delivery_not_confirmed" : "no_saved_delivery_record",
      generatedAt: d.saved?.attemptedAt || null, legacy: l, multiTimeframe: m,
      totals: {
        legacyGenerated: l.generated, legacyDelivered: l.delivered, legacyMissed: l.missed,
        legacyTp1: l.tp1, legacyTp2: l.wins, legacyLosses: l.losses,
        legacyExpired: l.expired, legacyUnresolved: l.unresolved,
        mtfObservations: m.generated, mtfDelivered: m.delivered, mtfMissed: m.missed,
        mtfTp1: m.tp1, mtfTp2: m.wins, mtfLosses: m.losses,
        mtfExpired: m.expired, mtfUnresolved: m.unresolved
      },
      savedDailyReport: d.saved?.stats ? { delivered: confirmed, attemptedAt: d.saved.attemptedAt || null, stats: d.saved.stats } : null
    };
  });
  return {
    schemaVersion: 1, generatedAt, timezone: "Africa/Kampala",
    methodology: {
      historicalCoverage: "All recoverable dates represented in the legacy and multi-timeframe journals or saved daily report records.",
      verified: "The existing daily runner writes delivered=true only after its Telegram delivery helper succeeds; an explicit telegramConfirmed=false overrides that legacy marker.",
      reconstructed: "Daily totals rebuilt from individual journal records; this does not prove a Telegram daily report was sent.",
      missingData: "Dates with no surviving journal or saved report records cannot be recreated and are not fabricated.",
      populations: "Legacy 15-minute and multi-timeframe observations remain separate; combined totals are not executed trades or account profit/loss."
    },
    coverage: {
      days: days.length, firstDate: days.length ? days[days.length - 1].date : null,
      lastDate: days.length ? days[0].date : null, legacySignals: legacy.length, multiTimeframeSignals: mtf.length,
      verifiedDailyReports: days.filter(d => d.recordStatus === "verified_daily_report").length,
      reconstructedDays: days.filter(d => d.recordStatus === "reconstructed_from_journals").length
    }, days
  };
}
function main() {
  const legacy = readJson(path.join(ROOT, "trade_journal.json"), { signals: [], dailyReports: {} });
  const mtf = readJson(path.join(ROOT, "multi_timeframe_journal.json"), { signals: [] });
  const archive = buildDailyPerformanceArchive(legacy, mtf);
  fs.writeFileSync(path.join(ROOT, "daily_performance_archive.json"), JSON.stringify(archive, null, 2) + "\n");
  console.log(JSON.stringify({ event: "daily_performance_archive_built", coverage: archive.coverage }));
  return archive;
}
if (require.main === module) main();
module.exports = { dateInUganda, legacyDate, mtfDate, compact, summarize, buildDailyPerformanceArchive, main };
