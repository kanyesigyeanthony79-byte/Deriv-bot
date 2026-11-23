"use strict";

// Rollout defaults are intentionally fail-closed. No provider or paper route is
// activated until a dedicated M1 scheduler and forward-paper checks are deployed.
module.exports = Object.freeze({
  instrument: "R_10",
  aliases: Object.freeze(["R_10", "Volatility 10 Index", "Volatility10Index", "Volatility 10", "Volatility 10 Index_M1"]),
  providerId: "volatility10_ema_atr_slope20_v1",
  strategyVersion: "volatility10_ema_atr_slope20_v1",
  flags: Object.freeze({
    exclusiveProviderMode: false,
    providerEnabled: false,
    paperRouteEnabled: false,
    liveExecutionEnabled: false,
    emergencyKillSwitch: true
  }),
  rollback: Object.freeze({
    restoreLegacyProviders: true,
    restoreLegacyNotificationRouting: true,
    keepLiveExecutionDisabled: true
  })
});
