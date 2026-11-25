"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateSignalCandle } = require("../signal_lifecycle");

const buy = { direction:"BUY", entry:100, stopLoss:90, tp1:110, tp2:115, entryTriggered:false, tp1Hit:false };
const sell = { direction:"SELL", entry:100, stopLoss:110, tp1:90, tp2:85, entryTriggered:false, tp1Hit:false };

test("pending BUY waits while price has not reached entry, TP1 or stop loss", () => {
  assert.deepEqual(evaluateSignalCandle(buy,{open:98,high:99,low:95,close:97}),{action:"WAIT"});
});
test("pending BUY expires only when TP1 is reached before entry", () => {
  assert.deepEqual(evaluateSignalCandle(buy,{open:112,high:114,low:111,close:113}),{action:"EXPIRED_TP1_BEFORE_ENTRY"});
});
test("pending BUY expires only when stop loss is reached before entry", () => {
  assert.deepEqual(evaluateSignalCandle(buy,{open:88,high:89,low:86,close:87}),{action:"EXPIRED_SL_BEFORE_ENTRY"});
});
test("pending BUY triggers entry before any target or stop", () => {
  assert.deepEqual(evaluateSignalCandle(buy,{open:98,high:104,low:96,close:103}),{action:"ENTRY_TRIGGERED"});
});
test("pending SELL follows mirrored price rules", () => {
  assert.deepEqual(evaluateSignalCandle(sell,{open:102,high:105,low:101,close:104}),{action:"WAIT"});
  assert.deepEqual(evaluateSignalCandle(sell,{open:88,high:89,low:86,close:87}),{action:"EXPIRED_TP1_BEFORE_ENTRY"});
  assert.deepEqual(evaluateSignalCandle(sell,{open:112,high:114,low:111,close:113}),{action:"EXPIRED_SL_BEFORE_ENTRY"});
});
test("after entry, TP1 is a milestone and does not close the signal", () => {
  assert.deepEqual(evaluateSignalCandle({...buy,entryTriggered:true},{open:104,high:112,low:101,close:111}),{action:"TP1_HIT"});
});
test("after entry, TP2 is terminal and stop loss remains terminal", () => {
  assert.deepEqual(evaluateSignalCandle({...buy,entryTriggered:true,tp1Hit:true},{open:111,high:116,low:109,close:115}),{action:"TP2_HIT"});
  assert.deepEqual(evaluateSignalCandle({...buy,entryTriggered:true},{open:98,high:99,low:89,close:91}),{action:"SL_HIT"});
});
test("OHLC candles touching both TP1 and SL remain ambiguous", () => {
  assert.deepEqual(evaluateSignalCandle({...buy,entryTriggered:true},{open:100,high:111,low:89,close:101}),{action:"AMBIGUOUS"});
});
