// Central Telegram allow-list for market-specific alert delivery.
// R_50 may send only tagged Original M15 research-priority alerts.
export function shouldDeliverTelegramAlert(data = {}) {
  if (data.event === "daily_summary") return true;
  const marketId = String(data.marketId || "").trim().toUpperCase();
  const market = String(data.market || "");
  const isR50 = marketId === "R_50" || /\\bvolatility\\s*50(?:\\s+index)?\\b/i.test(market);
  if (!isR50) return true;
  return data.source === "LEGACY_15M" && data.priorityTier === "RESEARCH_PRIORITY";
}
