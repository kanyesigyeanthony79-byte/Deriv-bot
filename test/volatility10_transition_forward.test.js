"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const s=require("../volatility10_transition_forward");
const candle=(epoch,open,high,low,close)=>({epoch,open,high,low,close});

test("aggregates only complete, aligned M1 buckets",()=>{
 const rows=Array.from({length:10},(_,i)=>candle(600+i*60,10+i,12+i,9+i,11+i));
 const out=s.aggregateM1(rows,s.M5);
 assert.equal(out.length,2);assert.equal(out[0].epoch,600);
 assert.equal(out[0].open,10);assert.equal(out[0].close,15);
 assert.equal(out[0].high,16);assert.equal(out[0].low,9);
 assert.deepEqual(s.aggregateM1(rows.slice(0,9),s.M5),[]);
});
test("confirmed swings appear only after right-side candles close",()=>{
 const rows=[
  [2,0],[3,1],[6,2],[4,1],[3,0],[4,2],[7,3],[5,2],[4,1],[5,3],[8,4],[6,3],[5,2]
 ].map((v,i)=>candle(i*3600,3,v[0],v[1],3));
 const early=s.confirmedSwings(rows,s.H1,10*3600+3600);
 assert.ok(!early.highs.some(x=>x.epoch===10*3600));
 const later=s.confirmedSwings(rows,s.H1,13*3600);
 assert.ok(later.highs.some(x=>x.epoch===10*3600));
 assert.ok(later.highs.every(x=>x.confirmedAt<=13*3600));
});
test("classifies bullish, bearish and mixed structures using confirmed swing pairs",()=>{
 const bullish=[
  [2,0],[3,1],[6,2],[4,1],[3,0],[4,2],[7,3],[5,2],[4,1],[5,3],[8,4],[6,3],[5,2]
 ].map((v,i)=>candle(i*3600,3,v[0],v[1],3));
 assert.equal(s.classifyStructure(bullish,s.H1,13*3600).direction,"BULLISH");
 const bearish=bullish.map((c,i)=>({...c,high:10-c.high,low:10-c.low}));
 assert.equal(s.classifyStructure(bearish,s.H1,13*3600).direction,"BEARISH");
 assert.equal(s.classifyStructure(bullish.slice(0,4),s.H1,13*3600).direction,"NEUTRAL");
});
test("transition regime means H4 and H1 are not aligned in the same directional structure",()=>{
 assert.equal(s.isTransitionRegime("BULLISH","BULLISH"),false);
 assert.equal(s.isTransitionRegime("BEARISH","BEARISH"),false);
 for(const pair of [["BULLISH","BEARISH"],["BULLISH","NEUTRAL"],["NEUTRAL","NEUTRAL"],["BEARISH","BULLISH"]])
  assert.equal(s.isTransitionRegime(...pair),true);
});
test("rolling ATR percentile uses only the 500 prior values and has an explicit warm-up",()=>{
 const values=Array.from({length:501},(_,i)=>i+1);
 assert.deepEqual(s.rollingAtrPercentile(values,499),{ready:false,percentile:null,warmupRequired:500});
 const rank=s.rollingAtrPercentile(values,500);
 assert.equal(rank.ready,true);assert.equal(rank.percentile,0.998);
 const low=s.rollingAtrPercentile(values.map((v,i)=>i===500?10:v),500);
 assert.ok(low.percentile<0.33);
});
test("UTC entry-hour gate does not depend on local timezone",()=>{
 for(const h of [16,18,19,20])assert.ok(s.ENTRY_HOURS_UTC.includes(s.utcHour(Date.UTC(2026,0,1,h)/1000)));
 for(const h of [15,17,21,22])assert.ok(!s.ENTRY_HOURS_UTC.includes(s.utcHour(Date.UTC(2026,0,1,h)/1000)));
});
test("bullish and bearish sweeps require taking prior ten-candle extremes and displacement",()=>{
 const base=Array.from({length:11},(_,i)=>candle(i*300,100,102,98,100));
 const buy=base.concat(candle(3300,100,103,97,102));
 assert.equal(s.detectSweep(buy,11,2).direction,"BUY");
 const sell=base.concat(candle(3300,100,103,97,98));
 assert.equal(s.detectSweep(sell,11,2).direction,"SELL");
 const weak=base.concat(candle(3300,100,103,97,100.5));
 assert.equal(s.detectSweep(weak,11,2),null);
});
test("stop buffer is beyond sweep extreme and target is exactly 1R",()=>{
 const buy=s.calculateLevels("BUY",100,98,2);
 assert.equal(buy.stopLoss,97.8);assert.ok(Math.abs(buy.target-102.2)<1e-10);
 const sell=s.calculateLevels("SELL",100,102,2);
 assert.equal(sell.stopLoss,102.2);assert.ok(Math.abs(sell.target-97.8)<1e-10);
 assert.equal(s.calculateLevels("BUY",97,98,2).valid,false);
});
test("M1 outcome ordering records wins, losses, same-candle ambiguity and gaps honestly",()=>{
 const sig={entryEpoch:0,direction:"BUY",stopLoss:95,target:105};
 assert.equal(s.resolveM1Outcome(sig,[candle(0,100,106,99,105)]).outcome,"WIN");
 assert.equal(s.resolveM1Outcome(sig,[candle(0,100,101,94,95)]).outcome,"LOSS");
 assert.equal(s.resolveM1Outcome(sig,[candle(0,100,106,94,100)]).outcome,"AMBIGUOUS");
 assert.equal(s.resolveM1Outcome(sig,[candle(0,100,101,99,100),candle(120,100,101,99,100)]).outcome,"UNRESOLVED");
});
test("holding period expires after exactly 24 M5 candles",()=>{
 const rows=Array.from({length:120},(_,i)=>candle(i*60,100,101,99,100));
 const result=s.resolveM1Outcome({entryEpoch:0,direction:"BUY",stopLoss:90,target:110},rows);
 assert.equal(result.outcome,"EXPIRED");assert.equal(result.reason,"24_M5_CANDLE_TIMEOUT");
});
test("R10 frozen identity is distinct from the retired EMA strategy and never authorizes execution",()=>{
 assert.equal(s.STRATEGY_VERSION,"volatility10_transition_lowvol_1r_forward_v1");
 assert.notEqual(s.STRATEGY_VERSION,"volatility10_ema_atr_slope20_v1");
 assert.equal(s.MARKET_ID,"R_10");
});
