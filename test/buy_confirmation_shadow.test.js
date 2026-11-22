"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateBuyConfirmationShadow } = require("../buy_confirmation_shadow");
const { updateJournal } = require("../multi_timeframe_journal");

function candidate(overrides = {}) {
  return {
    state: "signal", signalId: "JD100-SHORT_TERM-1", marketId: "JD100", category: "SHORT_TERM",
    direction: "BUY", score: 88, quality: "STRONG", entryCandleEpoch: 100,
    metrics: {
      entry: { bodyRatio: 0.6, closeLocation: 0.7, extensionAtr: 0.8 },
      confirmation: { direction: "BUY", separationAtr: 0.3, slopeAtr: 0.08 },
      context: { direction: "BUY", separationAtr: 0.2, slopeAtr: 0.03 }
    },
    ...overrides
  };
}

test("scoped BUY candidate passes the strict shadow gate", () => {
  const result = evaluateBuyConfirmationShadow(candidate());
  assert.equal(result.scoped, true);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.reasons, []);
});

test("scoped BUY candidate records each failed confirmation reason", () => {
  const result = evaluateBuyConfirmationShadow(candidate({ score: 84, quality: "VALID",
    metrics: { entry: { bodyRatio: 0.4, closeLocation: 0.5, extensionAtr: 1.2 },
      confirmation: { direction: "SELL", separationAtr: 0.1, slopeAtr: 0.01 },
      context: { direction: "BUY", separationAtr: 0.1, slopeAtr: 0.01 } } }));
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("score_below_minimum"));
  assert.ok(result.reasons.includes("confirmation_not_buy_aligned"));
  assert.ok(result.reasons.includes("entry_extension_above_maximum"));
});

test("SELL and unscoped BUY candidates are not filtered", () => {
  assert.deepEqual(evaluateBuyConfirmationShadow(candidate({ direction: "SELL" })), {
    version: "BUY_CONFIRMATION_SHADOW_V1", mode: "shadow_only", scoped: false, accepted: null, reasons: []
  });
  assert.equal(evaluateBuyConfirmationShadow(candidate({ marketId: "R_50" })).scoped, false);
});

test("journal stores the shadow annotation without changing the pending signal", () => {
  const result = updateJournal({ version: 1, signals: [] }, {
    JD100: { marketId: "JD100", signals: [candidate()], timeframes: {} }
  }, 150);
  const record = result.signals[0];
  assert.equal(record.status, "pending");
  assert.equal(record.telegramStatus, undefined);
  assert.equal(record.buyConfirmationShadow.accepted, true);
  assert.equal(record.buyConfirmationShadow.mode, "shadow_only");
});
