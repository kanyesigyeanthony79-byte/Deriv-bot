"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {adx,evaluateMarketRegime}=require("../market_regime_filter_shadow");
function trendCandles(n=180,step=1){
  const out=[];let p=100;
  for(let i=0;i<n;i++){
    const o=p,c=o+step+(i%5===0?0.15:0),h=Math.max(o,c)+0.25,l=Math.min(o,c)-0.15;
    out.push({epoch:i*900,open:o,high:h,low:l,close:c});p=c;
  }
  return out;
}
test("ADX is null until enough completed candles exist",()=>{
  assert.equal(adx(trendCandles(20)),null);
});
test("ADX detects a persistent directional move",()=>{
  const value=adx(trendCandles());
  assert.ok(Number.isFinite(value));
  assert.ok(value>22);
});
test("regime gate rejects missing higher-timeframe data",()=>{
  const result=evaluateMarketRegime({m15:[],m5:[],direction:"BUY",entryTimeframe:"M5"});
  assert.equal(result.passed,false);
  assert.equal(result.reason,"market_regime_rejected");
});
test("regime gate rejects disagreement with M15 direction",()=>{
  const m15=trendCandles();
  const result=evaluateMarketRegime({m15,m5:trendCandles(),direction:"SELL",entryTimeframe:"M5"});
  assert.equal(result.passed,false);
  assert.equal(result.marketDirection,"BUY");
});
test("M1 entries also require M5 direction agreement",()=>{
  const result=evaluateMarketRegime({m15:trendCandles(),m5:trendCandles().map(c=>({...c,open:c.open+300,high:c.high+300,low:c.low+300,close:c.close+300})).reverse(),direction:"BUY",entryTimeframe:"M1"});
  assert.equal(result.passed,false);
});
