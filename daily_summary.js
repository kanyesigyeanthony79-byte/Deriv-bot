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

function summarizeMtfCohorts(rows) {
  const groups = new Map();
  const keyOf = signal => [signal.marketId || signal.market || "unknown", signal.direction || "unknown", signal.category || "unknown"].join(" / ");
  for (const signal of rows) {
    const key = keyOf(signal);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(signal);
  }
  return [...groups.entries()].map(([key, cohort]) => {
    const delivered = cohort.filter(signal => signal.telegramStatus === "sent");
    const wins = delivered.filter(signal => signal.status === "tp2_hit").length;
    const losses = delivered.filter(signal => ["stopped", "stopped_after_tp1"].includes(signal.status)).length;
    const resolved = wins + losses;
    return {
      key, generated: cohort.length, delivered: delivered.length,
      deliveredWins: wins, deliveredLosses: losses, deliveredResolved: resolved,
      deliveredWinRate: resolved ? Number((wins / resolved * 100).toFixed(1)) : null,
      deliveredExpired: delivered.filter(signal => signal.status === "expired").length,
      priceOutOfRange: cohort.filter(signal => signal.telegramStatus === "missed" && signal.telegramStatusReason === "live_price_too_far_from_entry").length,
      stale: cohort.filter(signal => signal.telegramStatus === "stale").length,
      deliveryFailed: cohort.filter(signal => ["failed", "delivery_failed"].includes(signal.telegramStatus)).length,
      untracked: cohort.filter(signal => !signal.telegramStatus).length
    };
  }).sort((a, b) => b.deliveredResolved - a.deliveredResolved || b.generated - a.generated || a.key.localeCompare(b.key));
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
  const legacyDeliveryBreakdown = {
    sent,
    duplicateCooldown: rows.filter(signal => signal.status === "suppressed" && signal.statusReason === "duplicate_or_cooldown").length,
    stale: rows.filter(signal => signal.status === "stale").length,
    deliveryFailed: rows.filter(signal => signal.status === "delivery_failed").length,
    otherSuppressed: rows.filter(signal => signal.status === "suppressed" && signal.statusReason !== "duplicate_or_cooldown").length,
    untracked: rows.filter(signal => !signal.status || !["sent", "suppressed", "stale", "delivery_failed"].includes(String(signal.status).toLowerCase())).length
  };
  const priorityRows = rows.filter(signal => signal.priorityTier === "RESEARCH_PRIORITY");
  const priorityWins = priorityRows.filter(signal => signal.finalOutcome === "TP2").length;
  const priorityLosses = priorityRows.filter(signal => ["SL", "SL_AFTER_TP1"].includes(signal.finalOutcome)).length;
  const priorityResolved = priorityWins + priorityLosses;
  const priority = {
    generated: priorityRows.length,
    sent: priorityRows.filter(signal => signal.status === "sent").length,
    wins: priorityWins,
    losses: priorityLosses,
    resolved: priorityResolved,
    winRate: priorityResolved ? Number((priorityWins / priorityResolved * 100).toFixed(1)) : null,
    unresolved: priorityRows.filter(signal => signal.status === "sent" && !signal.finalOutcome).length,
    expired: priorityRows.filter(signal => signal.finalOutcome === "EXPIRED").length,
    ambiguous: priorityRows.filter(signal => signal.finalOutcome === "AMBIGUOUS").length
  };

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
  const mtfDeliveryMissed = mtfRows.filter(signal =>
    ["missed", "stale", "not_sent", "suppressed", "quote_unavailable"].includes(signal.telegramStatus)).length;
  const mtfDeliveryFailed = mtfRows.filter(signal =>
    ["failed", "delivery_failed"].includes(signal.telegramStatus)).length;
  const deliveryBreakdown = {
    sent: mtfSent,
    price_out_of_range: mtfRows.filter(signal => signal.telegramStatus === "missed" && signal.telegramStatusReason === "live_price_too_far_from_entry").length,
    tp1_already_reached: mtfRows.filter(signal => signal.telegramStatus === "missed" && signal.telegramStatusReason === "tp1_already_reached").length,
    stale: mtfRows.filter(signal => signal.telegramStatus === "stale").length,
    quote_unavailable: mtfRows.filter(signal => signal.telegramStatus === "quote_unavailable").length,
    delivery_failed: mtfDeliveryFailed,
    suppressed: mtfRows.filter(signal => ["suppressed", "not_sent"].includes(signal.telegramStatus)).length,
    baselineShadowOnly: mtfRows.filter(signal => ["suppressed", "not_sent"].includes(signal.telegramStatus) && signal.telegramStatusReason === "baseline_strategy_shadow_only").length,
    otherSuppressed: mtfRows.filter(signal => ["suppressed", "not_sent"].includes(signal.telegramStatus) && signal.telegramStatusReason !== "baseline_strategy_shadow_only").length,
    untracked: 0
  };
  const knownDeliveryStatuses = new Set([
    "sent", "missed", "stale", "not_sent", "suppressed", "failed", "delivery_failed", "quote_unavailable"
  ]);
  const mtfDeliveryUntracked = mtfRows.filter(signal =>
    !knownDeliveryStatuses.has(String(signal.telegramStatus || "").toLowerCase())).length;
  deliveryBreakdown.untracked = mtfDeliveryUntracked;
  const mtfResolved = mtfWins + mtfLosses;
  const mtfWinRate = mtfResolved ? Number((mtfWins / mtfResolved * 100).toFixed(1)) : null;
  const mtfByCohort = summarizeMtfCohorts(mtfRows);

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
    day, generated: rows.length, sent, missed, legacyDeliveryBreakdown, tp1, tp2, wins, losses, resolved, winRate,
    netSignalOutcomes, expired, ambiguous, unverified, unresolved, byMarket: legacyByMarket,
    priorityPairs: priority,
    mfeCount: movementRows.length, mfeTop: movementRows.slice(0, 12),
    legacyMfeCount: legacyMfe.length, mtfMfeCount: mtfMfe.length,
    multiTimeframe: {
      generated: mtfRows.length, sent: mtfSent, deliveryMissed: mtfDeliveryMissed,
      deliveryFailed: mtfDeliveryFailed, deliveryUntracked: mtfDeliveryUntracked,
      deliveryBreakdown,
      tp1: mtfTp1, tp2: mtfWins,
      wins: mtfWins, losses: mtfLosses, resolved: mtfResolved, winRate: mtfWinRate,
      netSignalOutcomes: mtfWins - mtfLosses, expired: mtfExpired,
      ambiguous: mtfAmbiguous, unverified: mtfUnverified, unresolved: mtfUnresolved,
      byMarket: mtfByMarket, byCohort: mtfByCohort, mfeCount: mtfMfe.length
    },
    mfeBySource: { legacy: legacyMfe.length, multiTimeframe: mtfMfe.length }
  };
}

function buildDailySummaryMessage(summary, accountSnapshot = null) {
  const mtf = summary.multiTimeframe || {
    generated: 0, sent: 0, deliveryMissed: 0, deliveryFailed: 0, deliveryUntracked: 0,
    deliveryBreakdown: { sent: 0, price_out_of_range: 0, tp1_already_reached: 0, stale: 0, quote_unavailable: 0, delivery_failed: 0, suppressed: 0, untracked: 0 }, tp1: 0,
    wins: 0, losses: 0, winRate: null, netSignalOutcomes: 0,
    expired: 0, ambiguous: 0, unverified: 0, unresolved: 0, byMarket: [], mfeCount: 0
  };
  const legacyMfeCount = summary.legacyMfeCount ?? summary.mfeCount;
  const mtfMfeCount = summary.mtfMfeCount ?? mtf.mfeCount;
  return "DAILY DERIV SIGNAL REPORT (" + summary.day + ")\n" +
    "LEGACY 15-MINUTE SIGNALS\n" +
    "Generated: " + summary.generated + "\nSent to Telegram: " + summary.sent +
    "\nMissed / not sent: " + summary.missed +
    "\nLegacy delivery breakdown: duplicate/cooldown " + (summary.legacyDeliveryBreakdown?.duplicateCooldown ?? 0) +
    ", stale " + (summary.legacyDeliveryBreakdown?.stale ?? 0) +
    ", delivery failures " + (summary.legacyDeliveryBreakdown?.deliveryFailed ?? 0) +
    ", other suppressed " + (summary.legacyDeliveryBreakdown?.otherSuppressed ?? 0) +
    ", untracked " + (summary.legacyDeliveryBreakdown?.untracked ?? 0) +
    "\nWins (TP2): " + summary.wins + "\nLosses (SL): " + summary.losses +
    "\nWin rate (resolved wins/losses): " + (summary.winRate === null ? "N/A" : summary.winRate + "%") +
    "\nNet signal outcomes (wins - losses): " + (summary.netSignalOutcomes > 0 ? "+" : "") + summary.netSignalOutcomes +
    "\nTP1 reached: " + summary.tp1 + "\nExpired: " + summary.expired +
    "\nAmbiguous: " + summary.ambiguous + "\nUnverified (state missing): " + summary.unverified +
    "\nStill open/unresolved: " + summary.unresolved +
    "\n\nPRIORITY PAIR RESEARCH WATCH (R_50)" +
    "\nGenerated: " + (summary.priorityPairs?.generated ?? 0) +
    "\nSent: " + (summary.priorityPairs?.sent ?? 0) +
    "\nWins (TP2): " + (summary.priorityPairs?.wins ?? 0) +
    "\nLosses (SL): " + (summary.priorityPairs?.losses ?? 0) +
    "\nResolved win rate: " + (summary.priorityPairs?.winRate == null ? "N/A" : summary.priorityPairs.winRate + "%") +
    "\nUnresolved: " + (summary.priorityPairs?.unresolved ?? 0) +
    "\nExpired: " + (summary.priorityPairs?.expired ?? 0) +
    "\nAmbiguous: " + (summary.priorityPairs?.ambiguous ?? 0) +
    "\nHistorical 62.9% directional follow-through is context only, not a strategy win rate." +
    "\n\nMULTI-TIMEFRAME OBSERVATION SIGNALS" +
    "\nGenerated: " + mtf.generated + "\nTelegram sent: " + mtf.sent +
    "\nNot sent (entry moved / stale / suppressed): " + (mtf.deliveryMissed ?? 0) +
    "\nDelivery failed: " + mtf.deliveryFailed +
    "\nDelivery status untracked: " + mtf.deliveryUntracked +
    "\nDelivery breakdown: price out of range " + (mtf.deliveryBreakdown?.price_out_of_range ?? 0) +
    ", TP1 already reached " + (mtf.deliveryBreakdown?.tp1_already_reached ?? 0) +
    ", stale " + (mtf.deliveryBreakdown?.stale ?? 0) +
    ", quote unavailable " + (mtf.deliveryBreakdown?.quote_unavailable ?? 0) +
    ", suppressed " + (mtf.deliveryBreakdown?.suppressed ?? 0) +
    " (baseline shadow-only " + (mtf.deliveryBreakdown?.baselineShadowOnly ?? 0) +
    ", other " + (mtf.deliveryBreakdown?.otherSuppressed ?? 0) + ")" +
    "\nWins (TP2): " + mtf.wins + "\nLosses (SL): " + mtf.losses +
    "\nWin rate (resolved wins/losses): " + (mtf.winRate === null ? "N/A" : mtf.winRate + "%") +
    "\nNet signal outcomes (wins - losses): " + (mtf.netSignalOutcomes > 0 ? "+" : "") + mtf.netSignalOutcomes +
    "\nTP1 reached: " + mtf.tp1 + "\nExpired: " + mtf.expired +
    "\nAmbiguous: " + mtf.ambiguous + "\nUnverified: " + mtf.unverified +
    "\nStill open/unresolved: " + mtf.unresolved +
    (mtf.byCohort?.filter(row => row.delivered > 0).length ?
      "\n\nDELIVERED MTF COHORTS (market / direction / category)\n" +
      mtf.byCohort.filter(row => row.delivered > 0).slice(0, 12).map(row =>
        row.key + ": " + row.delivered + " delivered, " + row.deliveredWins + " wins / " + row.deliveredLosses +
        " losses, resolved win rate " + (row.deliveredWinRate === null ? "N/A" : row.deliveredWinRate + "%") +
        ", " + row.deliveredExpired + " expired, " + row.deliveryFailed + " delivery failures"
      ).join("\n") +
      (mtf.byCohort.filter(row => row.delivered > 0).length > 12 ? "\n(Top 12 by resolved delivered sample; full cohort data is in the summary object.)" : "") : "") +
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
      ? "\nAccount: " + accountSnapshot.accountId +
        "\nBalance: " + accountSnapshot.balance + " " + accountSnapshot.currency +
        "\nEstimated equity: " + accountSnapshot.equityEstimate + " " + accountSnapshot.currency +
        "\nOpen contracts: " + accountSnapshot.openPositions.length +
        "\nCaptured: " + accountSnapshot.fetchedAt +
        "\nThis is a point-in-time demo account snapshot, not daily profit/loss."
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

module.exports = { dailySummary, summarizeMtfCohorts, buildDailySummaryMessage, deliverDailyReport, previousUgandaDay };
