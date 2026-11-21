"use strict";

// Precision V2 is a research-only veto layer. It never changes baseline signals,
// levels, journals, Telegram delivery, or execution. Thresholds are hypotheses,
// not calibrated probabilities; historical results require forward shadow validation.

const THRESHOLDS = Object.freeze({
  maxExtensionAtr: 1.0,
  minBodyRatio: 0.5,
  minCloseLocation: 0.65,
  minSwingAtr: 0.65,
  minSlopeAtr: 0.39
});

function finite(value) { return Number.isFinite(value); }

function evaluatePrecisionVariants(signal) {
  if (!signal || signal.state !== "signal" || !["BUY", "SELL"].includes(signal.direction)) {
    return { eligible: false, reason: "Expected a completed baseline signal.",
      baseline: false, extensionOnly: false, candleQualityOnly: false,
      combined: false, swingStructureOnly: false, trendSlopeOnly: false, checks: {} };
  }

  const entry = signal.metrics && signal.metrics.entry;
  const confirmation = signal.metrics && signal.metrics.confirmation;
  const context = signal.metrics && signal.metrics.context;
  if (!entry || !confirmation || !context) {
    return { eligible: false, reason: "Required entry, confirmation and context metrics are missing.",
      baseline: true, extensionOnly: false, candleQualityOnly: false,
      combined: false, swingStructureOnly: false, trendSlopeOnly: false, checks: {} };
  }

  const checks = {
    directionAgreement: confirmation.direction === signal.direction && context.direction === signal.direction,
    notOverextended: finite(entry.extensionAtr) && entry.extensionAtr <= THRESHOLDS.maxExtensionAtr,
    strongBody: finite(entry.bodyRatio) && entry.bodyRatio >= THRESHOLDS.minBodyRatio,
    directionalClose: finite(entry.closeLocation) && entry.closeLocation >= THRESHOLDS.minCloseLocation,
    meaningfulSwing: finite(entry.swingAtr) && entry.swingAtr >= THRESHOLDS.minSwingAtr,
    trendSlope: finite(entry.emaSlopeAtr) && entry.emaSlopeAtr >= THRESHOLDS.minSlopeAtr
  };

  const extensionOnly = checks.directionAgreement && checks.notOverextended;
  const candleQualityOnly = checks.directionAgreement && checks.strongBody && checks.directionalClose;
  const combined = extensionOnly && checks.strongBody && checks.directionalClose;
  const swingStructureOnly = checks.directionAgreement && checks.meaningfulSwing;
  const trendSlopeOnly = checks.directionAgreement && checks.trendSlope;

  return { eligible: true, baseline: true, extensionOnly, candleQualityOnly,
    combined, swingStructureOnly, trendSlopeOnly, checks, thresholds: THRESHOLDS };
}

// Expired, pending, ambiguous and incomplete outcomes remain separately visible.
function summarizePrecisionObservations(observations) {
  const variants = ["baseline", "extensionOnly", "candleQualityOnly", "combined",
    "swingStructureOnly", "trendSlopeOnly"];
  const result = {};
  for (const variant of variants) {
    const rows = (Array.isArray(observations) ? observations : [])
      .filter(row => row && row.variant === variant);
    const resolved = rows.filter(row => ["tp2_hit", "stopped", "stopped_after_tp1", "time_exit"].includes(row.status));
    const wins = resolved.filter(row => row.status === "tp2_hit").length;
    const losses = resolved.filter(row => row.status === "stopped").length;
    const rValues = resolved.map(row => row.realizedR).filter(finite);
    const grossProfit = rValues.filter(x => x > 0).reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(rValues.filter(x => x < 0).reduce((a, b) => a + b, 0));
    result[variant] = {
      observations: rows.length, resolved: resolved.length, wins, losses,
      partialAfterTp1: resolved.filter(row => row.status === "stopped_after_tp1").length,
      expired: rows.filter(row => row.status === "expired").length,
      pending: rows.filter(row => row.status === "pending").length,
      ambiguous: rows.filter(row => row.status === "ambiguous").length,
      decisiveWinRatePct: wins + losses ? Number((wins / (wins + losses) * 100).toFixed(2)) : null,
      averageRealizedR: rValues.length ? Number((rValues.reduce((a, b) => a + b, 0) / rValues.length).toFixed(4)) : null,
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(3)) : grossProfit > 0 ? "infinite" : null
    };
  }
  return { mode: "research_only_matched_observations",
    warning: "Compare variants on the same baseline population with identical entry, stop, target and expiry assumptions. Do not promote thresholds selected on this historical sample.",
    variants: result };
}

module.exports = { THRESHOLDS, evaluatePrecisionVariants, summarizePrecisionObservations };
