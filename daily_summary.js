"use strict";

function countByMarket(rows, markets, outcomeFn) {
  const names = new Map((markets || []).map(([id, name]) => [id, name]));
  const ids = [...new Set(rows.map(signal => signal.marketId || signal.market).filter(Boolean))];
  return ids.map(id => {
    const marketRows = rows.filter(signal => (signal.marketId || signal.market) === id);
    const outcomes = outcomeFn(marketRows);
    return (names.get(id) || marketRows[0].market || id) + ": " +
      marketRows.length + " generated, " + outcomes.wins + " wins (TP2), " +
      outcomes.losses + " losses (SL), " + outcomes.expired + " expired";
  });
}

function dailySummary(signals, day, markets, mtfSignals = []) {
  // The legacy scanner and multi-timeframe observer are separate signal pipelines.
  // Keep their counts separate so a multi-timeframe MFE record cannot appear to be
  // an unexplained movement attached to a legacy generated-signal total.
  const rows = (Array.isArray(signals) ? signals : [])
    .filter(signal => signal && signal.localDate === day);
  const sent = rows.filter(signal => signal.status === "sent").length;
  const missed = rows.filter(signal =>
    ["suppressed", "stale", "delivery_failed"].includes(signal.status)).length;
  const tp1 = rows.filter(signal => signal.tp1Hit === true).length;
  const tp2 = rows.filter(signal => signal.finalOutcome === "TP2" || signal.tp2Hit === true).length;
  const wins = rows.filter(signal => signal.finalOutcome === "TP2").length;
  const losses = rows.filter(signal => ["SL", "SL_AFTER_TP1"].includes(signal.finalOutcome)).length;
  const expired = rows.filter(signal => signal.finalOutcome === "EXPIRED").length;
  const ambiguous = rows.filter(signal => signal.finalOutcome === "AMBIGUOUS").length;
  const unverified = rows.filter(signal =>
    signal.finalOutcome === "UNVERIFIED" || signal.status === "state_missing").length;
  const unresolved = rows.filter(signal => signal.status === "sent" && !signal.finalOutcome).length;
  const resolved = wins + losses;
  const winRate = resolved ? Number((wins / resolved * 100).toFixed(1)) : null;
  const netSignalOutcomes = wins - losses;

  const localDate = epoch => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(epoch * 1000));
  const mtfRows = (Array.isArray(mtfSignals) ? mtfSignals : []).filter(signal =>
    signal && Number.isFinite(Number(signal.entryCandleEpoch)) &&
    localDate(Number(signal.entryCandleEpoch)) === day
  );

  const mtfWins = mtfRows.filter(signal => signal.status === "tp2_hit").length;
  const mtfLosses = mtfRows.filter(signal =>
    ["stopped", "stopped_after_tp1"].includes(signal.status)).length;
  const mtfTp1 = mtfRows.filter(signal => signal.tp1Hit === true).length;
  const mtfExpired = mtfRows.filter(signal => signal.status === "expired").length;
  const mtfAmbiguous = mtfRows.filter(signal => signal.status === "ambiguous").length;
  const mtfUnverified = mtfRows.filter(signal =>
    ["state_missing", "unverified"].includes(signal.status)).length;
  const mtfUnresolved = mtfRows.filter(signal =>
    !["tp2_hit", "stopped", "stopped_after_tp1", "expired", "ambiguous", "state_missing", "unverified"].includes(signal.status)).length;
  const mtfSent = mtfRows.filter(signal => signal.telegramStatus === "sent").length;
  const mtfDeliveryFailed = mtfRows.filter(signal =>
    ["failed", "delivery_failed", "not_sent"].includes(signal.telegramStatus)).length;
  const mtfDeliveryUntracked = mtfRows.filter(signal =>
    !signal.telegramStatus || !["sent", "failed", "delivery_failed", "not_sent"].includes(signal.telegramStatus)).length;
  const mtfResolved = mtfWins + mtfLosses;
  const mtfWinRate = mtfResolved ? Number((mtfWins / mtfResolved * 100).toFixed(1)) : null;

  const legacyMfe = rows.filter(signal => Number(signal.maxFavourablePoints) > 0).map(signal => ({
    market: signal.market || ((markets || []).find(([id]) => id === signal.marketId) || [null, signal.marketId])[1],
    direction: signal.direction, category: "Legacy", timeframe: "M15",
    points: Number(signal.maxFavourablePoints), pct: Number(signal.maxFavourablePct || 0)
  }));
  const mtfMfe = mtfRows.filter(signal => Number(signal.maxFavourablePoints) > 0).map(signal => ({
    market: signal.market || signal.marketId, direction: signal.direction,
    category: signal.category || "Multi-timeframe", timeframe: signal.entryTimeframe || "—",
    points: Number(signal.maxFavourablePoints), pct: Number(signal.maxFavourablePct || 0)
  }));
  const movementRows = [...legacyMfe, ...mtfMfe].sort((a, b) => b.pct - a.pct);

  const legacyByMarket = (markets || []).map(([id, name]) => {
    const marketRows = rows.filter(signal => signal.marketId === id);
    return name + ": " + marketRows.length + " generated, " +
      marketRows.filter(signal => signal.finalOutcome === "TP2").length + " wins (TP2), " +
      marketRows.filter(signal => ["SL", "SL_AFTER_TP1"].includes(signal.finalOutcome)).length + " losses (SL)";
  }).filter((_, index) => rows.some(signal => signal.marketId === markets[index][0]));

  const mtfByMarket = countByMarket(mtfRows, markets, marketRows => ({
    wins: marketRows.filter(signal => signal.status === "tp2_hit").length,
    losses: marketRows.filter(signal => ["stopped", "stopped_after_tp1"].includes(signal.status)).length,
    expired: marketRows.filter(signal => signal.status === "expired").length
  }));

  return {
    day, generated: rows.length, sent, missed, tp1, tp2, wins, losses, resolved, winRate,
    netSignalOutcomes, expired, ambiguous, unverified, unresolved, byMarket: legacyByMarket,
    mfeCount: movementRows.length, mfeTop: movementRows.slice(0, 12),
    legacyMfeCount: legacyMfe.length, mtfMfeCount: mtfMfe.length,
    multiTimeframe: {
      generated: mtfRows.length, sent: mtfSent, deliveryFailed: mtfDeliveryFailed,
      deliveryUntracked: mtfDeliveryUntracked, tp1: mtfTp1, tp2: mtfWins,
      wins: mtfWins, losses: mtfLosses, resolved: mtfResolved, winRate: mtfWinRate,
      netSignalOutcomes: mtfWins - mtfLosses, expired: mtfExpired,
      ambiguous: mtfAmbiguous, unverified: mtfUnverified, unresolved: mtfUnresolved,
      byMarket: mtfByMarket, mfeCount: mtfMfe.length
    },
    mfeBySource: { legacy: legacyMfe.length, multiTimeframe: mtfMfe.length }
  };
}

function buildDailySummaryMessage(summary, accountSnapshot = null) {
  const mtf = summary.multiTimeframe || {
    generated: 0, sent: 0, deliveryFailed: 0, deliveryUntracked: 0, tp1: 0,
    wins: 0, losses: 0, winRate: null, netSignalOutcomes: 0,
    expired: 0, ambiguous: 0, unverified: 0, unresolved: 0, byMarket: [], mfeCount: 0
  };
  const legacyMfeCount = summary.legacyMfeCount ?? summary.mfeCount;
  const mtfMfeCount = summary.mtfMfeCount ?? mtf.mfeCount;
  return "DAILY DERIV SIGNAL REPORT (" + summary.day + ")\n" +
    "LEGACY 15-MINUTE SIGNALS\n" +
    "Generated: " + summary.generated + "\nSent to Telegram: " + summary.sent +
    "\nMissed / not sent: " + summary.missed +
    "\nWins (TP2): " + summary.wins + "\nLosses (SL): " + summary.losses +
    "\nWin rate (resolved wins/losses): " + (summary.winRate === null ? "N/A" : summary.winRate + "%") +
    "\nNet signal outcomes (wins - losses): " + (summary.netSignalOutcomes > 0 ? "+" : "") + summary.netSignalOutcomes +
    "\nTP1 reached: " + summary.tp1 + "\nExpired: " + summary.expired +
    "\nAmbiguous: " + summary.ambiguous + "\nUnverified (state missing): " + summary.unverified +
    "\nStill open/unresolved: " + summary.unresolved +
    "\n\nMULTI-TIMEFRAME OBSERVATION SIGNALS" +
    "\nGenerated: " + mtf.generated + "\nTelegram sent: " + mtf.sent +
    "\nDelivery failed: " + mtf.deliveryFailed +
    "\nDelivery status untracked: " + mtf.deliveryUntracked +
    "\nWins (TP2): " + mtf.wins + "\nLosses (SL): " + mtf.losses +
    "\nWin rate (resolved wins/losses): " + (mtf.winRate === null ? "N/A" : mtf.winRate + "%") +
    "\nNet signal outcomes (wins - losses): " + (mtf.netSignalOutcomes > 0 ? "+" : "") + mtf.netSignalOutcomes +
    "\nTP1 reached: " + mtf.tp1 + "\nExpired: " + mtf.expired +
    "\nAmbiguous: " + mtf.ambiguous + "\nUnverified: " + mtf.unverified +
    "\nStill open/unresolved: " + mtf.unresolved +
    "\n\nMAX FAVOURABLE MOVEMENT (MFE)" +
    "\nLegacy positive-movement records: " + legacyMfeCount +
    "\nMulti-timeframe positive-movement records: " + mtfMfeCount +
    (summary.mfeTop.length ? "\nTop observations (both sources; not a combined trade count):\n" + summary.mfeTop.map(item =>
      item.market + " " + item.direction + " (" + item.category + "/" + item.timeframe + "): +" +
      item.points + " points (" + item.pct + "%)"
    ).join("\n") : "\nNo positive movement recorded or movement data not yet available.") +
    "\nMFE is the greatest favourable completed-candle excursion, not realised profit; it does not prove TP was reached before SL. Intrabar order and execution costs may be unknown." +
    "\n\nNote: Signal outcomes only; this is not actual account profit/loss." +
    (summary.byMarket.length ? "\n\nLEGACY BY MARKET\n" + summary.byMarket.join("\n") : "") +
    (mtf.byMarket.length ? "\n\nMULTI-TIMEFRAME BY MARKET\n" + mtf.byMarket.join("\n") : "") +
    "\n\nDEMO ACCOUNT SNAPSHOT (READ-ONLY)" +
    (accountSnapshot && accountSnapshot.status === "ok"
      ? "\nPlatform: " + (accountSnapshot.product || "MT5 CFDs") +
        "\nAccount: " + accountSnapshot.accountId + " (" + (accountSnapshot.accountType || "demo") + ")" +
        "\nBalance: " + accountSnapshot.balance + " " + accountSnapshot.currency +
        "\nEquity: Not available from the MT5 read-only account settings response." +
        "\nOpen positions: Not available from the MT5 read-only account settings response." +
        "\nCaptured: " + accountSnapshot.fetchedAt +
        "\nThis is a point-in-time MT5 demo balance snapshot, not daily profit/loss."
      : accountSnapshot && accountSnapshot.status === "unavailable"
        ? "\nUnavailable: the read-only demo account check failed. Signal report is still valid; no account P/L is inferred."
        : "\nNot connected: demo account snapshot credentials are not configured. Signal report only; no account P/L is inferred.");
}

async function deliverDailyReport(summary, accountSnapshot, postTelegram) {
  if (typeof postTelegram !== "function") throw new Error("daily_report_delivery_function_required");
  const message = buildDailySummaryMessage(summary, accountSnapshot);
  await postTelegram({ event: "daily_summary", message, text: message });
  return { delivered: true, message };
}

function previousUgandaDay(epochSeconds) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(epochSeconds * 1000));
  return new Date(Date.parse(today + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
}

module.exports = { dailySummary, buildDailySummaryMessage, deliverDailyReport, previousUgandaDay };
