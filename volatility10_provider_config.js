"use strict";

// R10 frozen forward-test provider. Defaults remain fail-closed.
const LEGACY_PROVIDER_ID = "volatility10_ema_atr_slope20_v1";
const PROVIDER_ID = "volatility10_transition_lowvol_1r_forward_v1";
const config = Object.freeze({
  instrument:"R_10",
  aliases:Object.freeze(["R_10","Volatility 10 Index","Volatility10Index","Volatility 10"]),
  providerId:PROVIDER_ID,
  strategyVersion:PROVIDER_ID,
  legacyProviderId:LEGACY_PROVIDER_ID,
  flags:Object.freeze({
    exclusiveProviderMode:true,providerEnabled:false,paperRouteEnabled:false,
    liveExecutionEnabled:false,brokerExecutionEnabled:false,emergencyKillSwitch:true
  }),
  rollback:Object.freeze({
    restoreLegacyProviders:"R10_LEGACY_ROLLBACK_ENABLED=true",
    restoreLegacyNotificationRouting:"R10_LEGACY_ROLLBACK_ENABLED=true",
    keepLiveExecutionDisabled:true,
    neverRestoreR10Mt5Execution:true
  })
});
module.exports=Object.freeze({
  ...config,
  legacyRollbackEnabled:env=>String((env||process.env).R10_LEGACY_ROLLBACK_ENABLED||"false")==="true",
  paperProviderEnabled:env=>String((env||process.env).R10_PAPER_PROVIDER_ENABLED||"false")==="true",
  paperRouteEnabled:env=>String((env||process.env).R10_PAPER_ROUTE_ENABLED||"false")==="true",
  emergencyKilled:env=>String((env||process.env).R10_EMERGENCY_KILL_SWITCH||"true")!=="false",
  brokerExecutionEnabled:()=>false
});
