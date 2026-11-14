"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {analyzeReversal}=require("../price_action_reversal");

function flatSeries(n=30,step=0) {
  const out=[]; let p=100;
  for(let i=0;i<n;i++){const o=p;p+=step;out.push({open:o,high:Math.max(o,p)+1,low:Math.min(o,p)-1,close:p});}
  return out;
}
function withLast(series,candle){const out=series.slice();out[out.length-1]=candle;return out;}
test("fails closed when any timeframe is missing or incomplete",()=>{
  const s=flatSeries();
  assert.equal(analyzeReversal({m1:s,m5:s,m15:s.slice(0,5)}).state,"insufficient_data");
  const incomplete=withLast(s,{open:100,high:103,low:99,close:102,complete:false});
  assert.equal(analyzeReversal({m1:incomplete,m5:s,m15:s}).state,"insufficient_data");
});
test("does not promote a single M1 pin bar into an execution signal",()=>{
  const s=flatSeries();
  const pin=withLast(s,{open:100,high:101,low:95,close:100.8});
  const r=analyzeReversal({market:"R_50",m1:pin,m5:s,m15:s});
  assert.equal(r.executionAllowed,false);
  assert.notEqual(r.state,"candidate");
});
test("returns neutral result for flat/no-pattern input",()=>{
  const s=flatSeries();
  const r=analyzeReversal({m1:s,m5:s,m15:s});
  assert.ok(["none","watch"].includes(r.state));
  assert.equal(r.executionAllowed,false);
});
test("all outputs remain research-only",()=>{
  const s=flatSeries(40,0.1);
  const r=analyzeReversal({market:"BOOM500",m1:s,m5:s,m15:s});
  assert.equal(r.executionAllowed,false);
  assert.ok(Array.isArray(r.candidates));
});
