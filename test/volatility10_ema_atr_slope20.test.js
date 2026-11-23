"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
  assert.equal(config.rollback.restoreLegacyProviders, "R10_LEGACY_ROLLBACK_ENABLED=true");
  assert.equal(config.emergencyKilled({}), true);
  assert.equal(config.emergencyKilled({R10_EMERGENCY_KILL_SWITCH:"false"}), false);
  assert.equal(config.paperProviderEnabled({R10_PAPER_PROVIDER_ENABLED:"true"}), true);
  assert.equal(config.paperRouteEnabled({R10_PAPER_ROUTE_ENABLED:"true"}), true);
  assert.equal(config.legacyRollbackEnabled({R10_LEGACY_ROLLBACK_ENABLED:"true"}), true);
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
  assert.equal(strategy.evaluateSignal(gap, {...next, epoch: gap.at(-1).epoch + 60}).reason, "warming_up_after_gap");
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
  const indicators = {ema12:[2, 3, 1], ema26:[1, 2, 2]};
  const candle = {epoch:1700000000, open:100, high:101, low:99, close:100};
  assert.equal(strategy.evaluateExit(position, candle, indicators, 1), null);
  assert.deepEqual(strategy.evaluateExit(position, candle, indicators, 2),
    {reason:"OPPOSITE_CROSS", exitPrice:100});
});

test("long and short signals contain the complete paper schema and symmetric 3 ATR exits", () => {
  const last = {epoch: 1700000000, open: 100, high: 101, low: 99, close: 100};
  const next = {epoch: 1700000060, open: 102, high: 103, low: 101, close: 102};
  const ind = {ema12:[null, 101], ema26:[null, 100], ema100:[null, 99], atr14:[null, 2], atrMedian1000:[null, 1]};
  const long = strategy.createSignalRecord("LONG", last, next, ind, 1);
  assert.equal(long.direction, "LONG");
  assert.equal(long.referenceEntryPrice, 102);
  assert.equal(long.stopLoss, 96);
  assert.equal(long.takeProfit, 108);
  assert.equal(long.providerId, strategy.PROVIDER_ID);
  assert.equal(long.timeframe, "M1");
  assert.equal(long.status, "PAPER");
  assert.equal(long.live, false);
  const short = strategy.createSignalRecord("SHORT", last, next, ind, 1);
  assert.equal(short.stopLoss, 108);
  assert.equal(short.takeProfit, 96);
});

test("EMA slope, crossover, close location and ATR median are all mandatory", () => {
  const bars = Array.from({length: 21}, (_, i) => ({close: 105}));
  const ind = {
    ema12: Array(21).fill(1), ema26: Array(21).fill(2), ema100: Array(21).fill(3),
    atr14: Array(21).fill(2), atrMedian1000: Array(21).fill(1)
  };
  ind.ema12[19] = 2; ind.ema26[19] = 2;
  ind.ema12[20] = 3; ind.ema26[20] = 2.5; ind.ema100[20] = 4;
  ind.ema12[0] = 1; ind.ema26[0] = 1; ind.ema100[0] = 2;
  assert.equal(strategy.qualifyDirection(bars, ind, 20), "LONG");
  ind.ema100[20] = 2; // Close is above EMA100, but EMA100 slope is not rising.
  assert.equal(strategy.qualifyDirection(bars, ind, 20), null);
  ind.ema100[20] = 4; ind.atr14[20] = 0.5;
  assert.equal(strategy.qualifyDirection(bars, ind, 20), null);
  ind.atr14[20] = 2; ind.ema12[20] = 1; ind.ema26[20] = 2;
  ind.ema12[19] = 2; ind.ema26[19] = 2;
  ind.ema12[0] = 3; ind.ema26[0] = 3; ind.ema100[0] = 5;
  ind.ema100[20] = 2; bars[20].close = 1;
  assert.equal(strategy.qualifyDirection(bars, ind, 20), "SHORT");
});

test("reference entry uses only the next candle open, not its high, low or close", () => {
  const last = {epoch: 1700000000, open: 100, high: 101, low: 99, close: 100};
  const ind = {ema12:[null, 101], ema26:[null, 100], ema100:[null, 99], atr14:[null, 2], atrMedian1000:[null, 1]};
  const a = strategy.createSignalRecord("LONG", last, {epoch:1700000060,open:102,high:999,low:1,close:500}, ind, 1);
  const b = strategy.createSignalRecord("LONG", last, {epoch:1700000060,open:102,high:103,low:101,close:102}, ind, 1);
  assert.equal(a.referenceEntryPrice, b.referenceEntryPrice);
  assert.equal(a.stopLoss, b.stopLoss);
  assert.equal(a.takeProfit, b.takeProfit);
});

test("provider exclusivity gates legacy Volatility 10 producers and paper notification route", () => {
  const worker = fs.readFileSync(path.join(__dirname,"../workers/deriv-telegram-alerts/worker.js"),"utf8");
  const hosted = fs.readFileSync(path.join(__dirname,"../hosted_scanner.js"),"utf8");
  const collector = fs.readFileSync(path.join(__dirname,"../multi_timeframe_collector.js"),"utf8");
  const alerts = fs.readFileSync(path.join(__dirname,"../multi_timeframe_alerts.js"),"utf8");
  assert.match(worker,/function isVolatility10Alert/);
  assert.match(worker,/volatility10_paper_only/);
  assert.match(worker,/data\.providerId === "volatility10_ema_atr_slope20_v1"/);
  assert.match(worker,/env\.R10_PAPER_ROUTE_ENABLED === "true"/);
  assert.match(worker,/env\.R10_EMERGENCY_KILL_SWITCH === "false"/);
  assert.match(hosted,/id === "R_10" && process\.env\.R10_LEGACY_ROLLBACK_ENABLED !== "true"/);
  assert.match(collector,/marketId === "R_10" && process\.env\.R10_LEGACY_ROLLBACK_ENABLED !== "true"/);
  assert.match(alerts,/new Set\(\["R_25", "R_50", "R_75", "JD100", "CRASH500", "BOOM500"\]\)/);
});

test("other instrument scanner registrations remain present", () => {
  const hosted = fs.readFileSync(path.join(__dirname,"../hosted_scanner.js"),"utf8");
  const collector = fs.readFileSync(path.join(__dirname,"../multi_timeframe_collector.js"),"utf8");
  for (const id of ["R_25","R_50","R_75","JD100","CRASH500","BOOM500"]) {
    assert.ok(hosted.includes('"'+id+'"'),"hosted scanner retains "+id);
    assert.ok(collector.includes('"'+id+'"'),"MTF collector retains "+id);
  }
});

test("emergency kill switch and paper route defaults are fail-closed", () => {
  const config = require("../volatility10_provider_config");
  assert.equal(config.emergencyKilled({}), true);
  assert.equal(config.paperRouteEnabled({}), false);
  assert.equal(config.paperProviderEnabled({}), false);
  assert.equal(config.flags.liveExecutionEnabled, false);
});

test("duplicate signal candle and existing position are gated", () => {
  assert.equal(strategy.signalGate(1700000060,{lastSignalEpoch:1700000060}),"duplicate_candle");
  assert.equal(strategy.signalGate(1700000120,{activePosition:{direction:"LONG"}}),"position_already_open");
  assert.equal(strategy.signalGate(1700000180,{}),null);
});

test("only completed candles are used; the next candle is exposed for its open", () => {
  const {splitCandleHistory} = require("../volatility10_paper_scanner");
  const rows = [
    {epoch:1000,open:10,high:11,low:9,close:10.5},
    {epoch:1060,open:10.5,high:11.5,low:10,close:11}
  ];
  const split = splitCandleHistory(rows,1050);
  assert.equal(split.completed.length,0);
  assert.equal(split.nextCandle.epoch,1000);
  const afterClose = splitCandleHistory(rows,1060);
  assert.equal(afterClose.completed.length,1);
  assert.equal(afterClose.completed[0].epoch,1000);
  assert.equal(afterClose.nextCandle.epoch,1060);
});

test("duplicate signal candle and existing position are gated", () => {
  assert.equal(strategy.signalGate(1700000060,{lastSignalEpoch:1700000060}),"duplicate_candle");
  assert.equal(strategy.signalGate(1700000120,{activePosition:{direction:"LONG"}}),"position_already_open");
  assert.equal(strategy.signalGate(1700000180,{}),null);
});

test("only completed candles are used; the next candle is exposed for its open", () => {
  const {splitCandleHistory} = require("../volatility10_paper_scanner");
  const rows = [
    {epoch:1000,open:10,high:11,low:9,close:10.5},
    {epoch:1060,open:10.5,high:11.5,low:10,close:11}
  ];
  const split = splitCandleHistory(rows,1050);
  assert.equal(split.completed.length,0);
  assert.equal(split.nextCandle.epoch,1000);
  const afterClose = splitCandleHistory(rows,1060);
  assert.equal(afterClose.completed.length,1);
  assert.equal(afterClose.completed[0].epoch,1000);
  assert.equal(afterClose.nextCandle.epoch,1060);
});
