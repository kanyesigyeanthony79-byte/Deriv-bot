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
