"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {evaluateStep300} = require("../step300");

function risingCandles(n=70) {
  return Array.from({length:n},(_,i)=>{
    const open=100+i;
    return {epoch:i*300,open,high:open+0.8,low:open-0.2,close:open+0.6};
  });
}

test("accepts aligned five-candle bullish streak with fifth body ratio inside band",()=>{
  const r=evaluateStep300(risingCandles());
  assert.equal(r.signal,"BUY");
  assert.ok(r.bodyRatio>=0.5 && r.bodyRatio<=0.8);
  assert.ok(r.emaSeparationMedianRanges>=0.5);
});

test("rejects fifth candle above 0.80 body/range",()=>{
  const cs=risingCandles();
  const c=cs.at(-1); c.high=c.open+1; c.low=c.open; c.close=c.open+0.9;
  assert.equal(evaluateStep300(cs).signal,null);
});

test("rejects a broken five-candle streak",()=>{
  const cs=risingCandles(); const c=cs.at(-1); c.close=c.open-0.6; c.high=c.open+0.2; c.low=c.open-0.8;
  assert.equal(evaluateStep300(cs).signal,null);
});

test("requires at least 50 completed candles",()=>{
  assert.equal(evaluateStep300(risingCandles(49)).state,"warming");
});
