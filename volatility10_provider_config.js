"use strict";

// Rollout defaults are intentionally fail-closed. No provider or paper route is
// activated until a dedicated M1 scheduler and forward-paper checks are deployed.
const config = Object.freeze({
  instrument: "R_10",
  aliases: Object.freeze(["R_10", "Volatility 10 Index", "Volatility10Index", "Volatility 10", "Volatility 10 Index_M1"]),
  providerId: "volatility10_ema_atr_slope20_v1",
  strategyVersion: "volatility10_ema_atr_slope20_v1",
  flags: Object.freeze({
    exclusiveProviderMode: true,
    providerEnabled: false,
    paperRouteEnabled: false,
    liveExecutionEnabled: false,
    emergencyKillSwitch: true
  }),
  rollback: Object.freeze({
    restoreLegacyProviders: "R10_LEGACY_ROLLBACK_ENABLED=true",
    restoreLegacyNotificationRouting: "R10_LEGACY_ROLLBACK_ENABLED=true",
    keepLiveExecutionDisabled: true
  })
});

module.exports = Object.freeze({
  ...config,
  legacyRollbackEnabled: env => String((env || process.env).R10_LEGACY_ROLLBACK_ENABLED || "false") === "true",
  paperProviderEnabled: env => String((env || process.env).R10_PAPER_PROVIDER_ENABLED || "false") === "true",
  paperRouteEnabled: env => String((env || process.env).R10_PAPER_ROUTE_ENABLED || "false") === "true",
  emergencyKilled: env => String((env || process.env).R10_EMERGENCY_KILL_SWITCH || "true") !== "false"
});
