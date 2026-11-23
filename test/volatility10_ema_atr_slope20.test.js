"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const strategy = require("../volatility10_ema_atr_slope20");

test("canonicalizes all requested Volatility 10 aliases only", () => {
  for (const alias of ["R_10", "Volatility 10 Index", "Volatility10Index", "Volatility 10", "Volatility 10 Index_M1"]) {
    assert.equal(strategy.canonicalMarketId(alias), "R_10");
  }
  assert.equal(strategy.canonicalMarketId("R_25"), null);
  assert.equal(strategy.canonicalMarketId("Volatility 25 Index"), null);
});

test("EMA and ATR helpers are deterministic and do not use future values", () => {
  const values = [1, 2, 3, 4, 5, 6];
  const result = strategy.ema(values, 3);
  assert.deepEqual(result.slice(0, 3), [null, null, 2]);
  const prefix = strategy.ema(values.slice(0, 5), 3);
  assert.equal(result[4], prefix[4]);
  assert.equal(strategy.median([1, 9, 3, 5]), 4);
});

test("provider configuration is fail-closed, paper-only and rollback-ready", () => {
  const config = require("../volatility10_provider_config");
  assert.equal(config.providerId, strategy.PROVIDER_ID);
  assert.equal(config.flags.providerEnabled, false);
  assert.equal(config.flags.paperRouteEnabled, false);
  assert.equal(config.flags.liveExecutionEnabled, false);
  assert.equal(config.flags.emergencyKillSwitch, true);
  assert.equal(config.rollback.restoreLegacyProviders, true);
});

test("insufficient history cannot emit a signal", () => {
  assert.equal(strategy.evaluateSignal([], null).reason, "warming_up");
});

test("signal evaluation rejects a non-adjacent next candle and candle gaps", () => {
  const base = Array.from({length: 1200}, (_, i) => ({
    epoch: 1700000000 + i * 60, open: 100 + i * 0.01, high: 101 + i * 0.01,
    low: 99 + i * 0.01, close: 100.2 + i * 0.01
  }));
  const next = {epoch: base.at(-1).epoch + 120, open: 113, high: 114, low: 112, close: 113};
  assert.equal(strategy.evaluateSignal(base, next).reason, "next_candle_not_aligned");
  const gap = base.slice();
  gap[900] = {...gap[900], epoch: gap[900].epoch + 60};
  assert.equal(strategy.evaluateSignal(gap, {...next, epoch: gap.at(-1).epoch + 60}).reason, "candle_gap");
});

test("stop-first exit ordering applies when a candle touches both barriers", () => {
  const position = {direction:"LONG", stopLoss:95, takeProfit:105, entryIndex:0};
  const indicators = {ema12:[], ema26:[]};
  const candle = {epoch:1700000000, open:100, high:106, low:94, close:101};
  assert.deepEqual(strategy.evaluateExit(position, candle, indicators, 0),
    {reason:"STOP_LOSS", exitPrice:95});
});

test("short stop-first exit ordering applies when a candle touches both barriers", () => {
  const position = {direction:"SHORT", stopLoss:105, takeProfit:95, entryIndex:0};
  const indicators = {ema12:[], ema26:[]};
  const candle = {epoch:1700000000, open:100, high:106, low:94, close:99};
  assert.deepEqual(strategy.evaluateExit(position, candle, indicators, 0),
    {reason:"STOP_LOSS", exitPrice:105});
});

test("opposite EMA cross cannot exit before three bars", () => {
  const position = {direction:"LONG", stopLoss:90, takeProfit:110, entryIndex:0};
  const indicators = {ema12:[2, 1, 1], ema26:[1, 2, 2]};
  const candle = {epoch:1700000000, open:100, high:101, low:99, close:100};
  assert.equal(strategy.evaluateExit(position, candle, indicators, 1), null);
  assert.deepEqual(strategy.evaluateExit(position, candle, indicators, 2),
    {reason:"OPPOSITE_CROSS", exitPrice:100});
});
