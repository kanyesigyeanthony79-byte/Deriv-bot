"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { reviewSignal } = require("../signal_review");
const signal = { signalId:"R_25-SCALP-1000",direction:"BUY",entry:100,stopLoss:90,tp1:110,tp2:120,entryTimeframe:"M1" };
const candles = (count, close=105, low=104, high=106) => Array.from({length:count},(_,i)=>({epoch:1000+i*60,open:close-0.2,high,low,close}));
test("rejects missing signal",()=>assert.throws(()=>reviewSignal(null,{})));
test("reports stale candles without a safety claim",()=>{
 const r=reviewSignal(signal,{M1:candles(60)},100000);
 assert.equal(r.status,"STALE_DATA");
});
test("reports insufficient history",()=>{
 const r=reviewSignal(signal,{M1:candles(10)},1000+10*60);
 assert.equal(r.status,"INSUFFICIENT_HISTORY");
});
test("flags stop touched before trend assessment",()=>{
 const r=reviewSignal(signal,{M1:candles(60,95,89,96)},1000+60*60);
 assert.equal(r.status,"STOP_LEVEL_TOUCHED");
});
test("review never mutates original signal levels",()=>{
 const original={...signal};
 reviewSignal(signal,{M1:candles(60)},1000+60*60);
 assert.deepEqual(signal,original);
});

test("flags same-candle stop and target as ambiguous",()=>{
 const r=reviewSignal(signal,{M1:candles(60,95,89,111)},1000+60*60);
 assert.equal(r.status,"AMBIGUOUS_CANDLE");
});

test("scans all post-signal candles, not only the latest candle",()=>{
 const series=candles(60,105,104,106);
 series[10]={epoch:1600,open:105,high:111,low:104,close:109};
 series[11]={epoch:1660,open:105,high:106,low:89,close:95};
 const r=reviewSignal({...signal,entryCandleEpoch:1000},{M1:series},1000+60*60);
 assert.equal(r.status,"STOP_AFTER_TP1");
 assert.equal(r.tp1Reached,true);
});
test("does not report an old stop touch as safe when latest candle recovers",()=>{
 const series=candles(60,105,104,106);
 series[10]={epoch:1600,open:105,high:106,low:89,close:95};
 const r=reviewSignal({...signal,entryCandleEpoch:1000},{M1:series},1000+60*60);
 assert.equal(r.status,"STOP_LEVEL_TOUCHED");
});
