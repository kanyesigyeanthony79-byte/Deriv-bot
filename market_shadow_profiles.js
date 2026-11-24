"use strict";

const { DEF, evaluate } = require("./engine");

// Experimental only: these profiles are evaluated alongside the active defaults.
// They must not be used to place orders or suppress baseline alerts until forward
// validation proves a durable improvement.
const SHADOW_PROFILES = Object.freeze({
  R_75: Object.freeze({
    ...DEF,
    minScore: 65,
    minBody: 0.60,
    maxExt: 1.00,
    minCloseLocation: 0.88,
    cooldown: 8
  }),
  JD100: Object.freeze({
    ...DEF,
    minScore: 65,
    minBody: 0.60,
    maxExt: 1.00,
    minCloseLocation: 0.85,
    cooldown: 8
  })
});

function shadowProfileForMarket(marketId) {
  return SHADOW_PROFILES[marketId] || null;
}

function evaluateMarketShadow(candles, marketId) {
  const profile = shadowProfileForMarket(marketId);
  if (!profile) return null;
  const result = evaluate(candles, profile);
  return {
    profile: {
      minScore: profile.minScore,
      minBody: profile.minBody,
      maxExt: profile.maxExt,
      minCloseLocation: profile.minCloseLocation,
      cooldown: profile.cooldown
    },
    signal: result.signal || null,
    state: result.state || null,
    score: result.score ?? null,
    metrics: result.metrics || null,
    checks: result.checks || []
  };
}

module.exports = { SHADOW_PROFILES, shadowProfileForMarket, evaluateMarketShadow };
