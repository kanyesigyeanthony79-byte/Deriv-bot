"use strict";

function dailySummary(signals, day, markets, mtfSignals = []) {
  const rows = (Array.isArray(signals) ? signals : []).filter(signal => signal && signal.localDate === day);
  const sent = rows.filter(signal => signal.status === "sent").length;
  const missed = rows.filter(signal => ["suppressed", "stale", "delivery_failed"].includes(signal.status)).length;
  const tp1 = rows.filter(signal => signal.tp1Hit === true).length;
  const tp2 = rows.filter(signal => signal.finalOutcome === "TP2" || signal.tp2Hit === true).length;
  const wins = rows.filter(signal => signal.finalOutcome === "TP2").length;
  const losses = rows.filter(signal => ["SL", "SL_AFTER_TP1"].includes(signal.finalOutcome)).length;
  const expired = rows.filter(signal => signal.finalOutcome === "EXPIRED").length;
  const ambiguous = rows.filter(signal => signal.finalOutcome === "AMBIGUOUS").length;
  const unverified = rows.filter(signal => signal.finalOutcome === "UNVERIFIED" || signal.status === "state_missing").length;
  const unresolved = rows.filter(signal => signal.status === "sent" && !signal.finalOutcome).length;
  const resolved = wins + losses;
  const winRate = resolved ? Number((wins / resolved * 100).toFixed(1)) : null;
  const netSignalOutcomes = wins - losses;
  const localDate = epoch => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(epoch * 1000));
  const mtfRows = (Array.isArray(mtfSignals) ? mtfSignals : []).filter(signal =>
    signal && signal.category !== "SWING" && Number.isFinite(Number(signal.entryCandleEpoch)) &&
    localDate(Number(signal.entryCandleEpoch)) === day
  );
  const movementRows = [
    ...rows.filter(signal => Number(signal.maxFavourablePoints) > 0).map(signal => ({
      market: signal.market || (markets.find(([id]) => id === signal.marketId) || [null, signal.marketId])[1],
      direction: signal.direction, category: "Legacy", timeframe: "M15",
      points: Number(signal.maxFavourablePoints), pct: Number(signal.maxFavourablePct || 0)
    })),
    ...mtfRows.filter(signal => Number(signal.maxFavourablePoints) > 0).map(signal => ({
      market: signal.market || signal.marketId, direction: signal.direction,
      category: signal.category, timeframe: signal.entryTimeframe,
      points: Number(signal.maxFavourablePoints), pct: Number(signal.maxFavourablePct || 0)
    }))
  ].sort((a, b) => b.pct - a.pct);
  const byMarket = (markets || []).map(([id, name]) => {
    const marketRows = rows.filter(signal => signal.marketId === id);
    return name + ": " + marketRows.length + " generated, " +
      marketRows.filter(signal => signal.finalOutcome === "TP2").length + " wins (TP2), " +
      marketRows.filter(signal => ["SL", "SL_AFTER_TP1"].includes(signal.finalOutcome)).length + " losses (SL)";
  }).filter((_, index) => rows.some(signal => signal.marketId === markets[index][0]));
  return { day, generated: rows.length, sent, missed, tp1, tp2, wins, losses, resolved, winRate,
    netSignalOutcomes, expired, ambiguous, unverified, unresolved, byMarket,\n    mfeCount: movementRows.length, mfeTop: movementRows.slice(0, 12) };
}

function buildDailySummaryMessage(summary) {
  return "DAILY DERIV SIGNAL REPORT (" + summary.day + ")\n" +
    "Generated: " + summary.generated + "\nSent to Telegram: " + summary.sent +
    "\nMissed / not sent: " + summary.missed +
    "\nWins (TP2): " + summary.wins + "\nLosses (SL): " + summary.losses +
    "\nWin rate (resolved wins/losses): " + (summary.winRate === null ? "N/A" : summary.winRate + "%") +
    "\nNet signal outcomes (wins - losses): " + (summary.netSignalOutcomes > 0 ? "+" : "") + summary.netSignalOutcomes +
    "\nTP1 reached: " + summary.tp1 + "\nExpired: " + summary.expired +
    "\nAmbiguous: " + summary.ambiguous + "\nUnverified (state missing): " + summary.unverified +
    "\nStill open/unresolved: " + summary.unresolved +
    "\n\nNote: Signal outcomes only; this is not actual account profit/loss." +
    (summary.byMarket.length ? "\n\nBY MARKET\n" + summary.byMarket.join("\n") : "");
}

function previousUgandaDay(epochSeconds) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(epochSeconds * 1000));
  return new Date(Date.parse(today + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
}

module.exports = { dailySummary, buildDailySummaryMessage, previousUgandaDay };
