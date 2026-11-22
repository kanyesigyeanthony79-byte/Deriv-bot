"use strict";

const CONFIG = require("./buy_confirmation_shadow_config.json");

function cohortKey(candidate) {
  return String(candidate?.marketId || "unknown") + " / " + String(candidate?.category || "unknown");
}

function evaluateBuyConfirmationShadow(candidate) {
  const scoped = Boolean(candidate && candidate.direction === "BUY" &&
    CONFIG.scope.marketCategoryCohorts.includes(cohortKey(candidate)));
  const base = { version: CONFIG.version, mode: CONFIG.mode, scoped, accepted: null, reasons: [] };
  if (!scoped) return base;

  const reasons = [];
  const entry = candidate.metrics?.entry || {};
  const confirmation = candidate.metrics?.confirmation || {};
  const context = candidate.metrics?.context || {};
  const requireNumber = (value, name) => {
    if (!Number.isFinite(Number(value))) { reasons.push(name + "_missing"); return null; }
    return Number(value);
  };
  const score = requireNumber(candidate.score, "score");
  const confirmationSeparation = requireNumber(confirmation.separationAtr, "confirmation_separation_atr");
  const confirmationSlope = requireNumber(confirmation.slopeAtr, "confirmation_slope_atr");
  const contextSeparation = requireNumber(context.separationAtr, "context_separation_atr");
  const contextSlope = requireNumber(context.slopeAtr, "context_slope_atr");
  const bodyRatio = requireNumber(entry.bodyRatio, "entry_body_ratio");
  const closeLocation = requireNumber(entry.closeLocation, "entry_close_location");
  const extensionAtr = requireNumber(entry.extensionAtr, "entry_extension_atr");

  if (candidate.quality !== CONFIG.rules.requiredQuality) reasons.push("quality_below_required");
  if (score !== null && score < CONFIG.rules.minimumScore) reasons.push("score_below_minimum");
  if (confirmation.direction !== CONFIG.rules.confirmation.requiredDirection) reasons.push("confirmation_not_buy_aligned");
  if (confirmationSeparation !== null && confirmationSeparation < CONFIG.rules.confirmation.minimumSeparationAtr) reasons.push("confirmation_separation_below_minimum");
  if (confirmationSlope !== null && confirmationSlope < CONFIG.rules.confirmation.minimumSlopeAtr) reasons.push("confirmation_slope_below_minimum");
  if (context.direction !== CONFIG.rules.context.requiredDirection) reasons.push("context_not_buy_aligned");
  if (contextSeparation !== null && contextSeparation < CONFIG.rules.context.minimumSeparationAtr) reasons.push("context_separation_below_minimum");
  if (contextSlope !== null && contextSlope < CONFIG.rules.context.minimumSlopeAtr) reasons.push("context_slope_below_minimum");
  if (bodyRatio !== null && bodyRatio < CONFIG.rules.entryCandle.minimumBodyRatio) reasons.push("entry_body_ratio_below_minimum");
  if (closeLocation !== null && closeLocation < CONFIG.rules.entryCandle.minimumCloseLocation) reasons.push("entry_close_location_below_minimum");
  if (extensionAtr !== null && extensionAtr > CONFIG.rules.entryCandle.maximumExtensionAtr) reasons.push("entry_extension_above_maximum");

  return { ...base, accepted: reasons.length === 0, reasons,
    thresholds: {
      minimumScore: CONFIG.rules.minimumScore,
      confirmationSeparationAtr: CONFIG.rules.confirmation.minimumSeparationAtr,
      confirmationSlopeAtr: CONFIG.rules.confirmation.minimumSlopeAtr,
      contextSeparationAtr: CONFIG.rules.context.minimumSeparationAtr,
      contextSlopeAtr: CONFIG.rules.context.minimumSlopeAtr,
      minimumBodyRatio: CONFIG.rules.entryCandle.minimumBodyRatio,
      minimumCloseLocation: CONFIG.rules.entryCandle.minimumCloseLocation,
      maximumExtensionAtr: CONFIG.rules.entryCandle.maximumExtensionAtr
    }
  };
}

module.exports = { CONFIG, cohortKey, evaluateBuyConfirmationShadow };
