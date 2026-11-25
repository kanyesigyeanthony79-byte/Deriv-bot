"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const s=require("../volatility10_transition_forward");
const scanner=require("../volatility10_transition_forward_scanner");
const candle=(epoch,open,high,low,close)=>({epoch,open,high,low,close});

test("aggregates only complete, aligned M1 buckets",()=>{
 const rows=Array.from({length:10},(_,i)=>candle(600+i*60,10+i,12+i,9+i,11+i));
 const out=s.aggregateM1(rows,s.M5);
 assert.equal(out.length,2);assert.equal(out[0].epoch,600);
 assert.equal(out[0].open,10);assert.equal(out[0].close,15);
 assert.equal(out[0].high,16);assert.equal(out[0].low,9);
 assert.equal(s.aggregateM1(rows.slice(0,9),s.M5).length,1,"incomplete trailing M5 bucket is excluded");
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
 const bearish=bullish.map(c=>({...c,high:20-c.low,low:20-c.high}));
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
 assert.equal(rank.ready,true);assert.equal(rank.percentile,1);
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

function lowVolSetupFixture(){
 const end=Date.UTC(2026,0,1,15,55)/1000;
 const start=end-519*300;
 const m5=Array.from({length:520},(_,i)=>{
  const epoch=start+i*300;
  return i<400?candle(epoch,100,102,98,100.2):candle(epoch,100,100.25,99.75,100.05);
 });
 m5[519]=candle(end,99.8,100.3,99.5,100.25);
 const h1=Array.from({length:8},(_,i)=>candle(Math.floor(start/3600)*3600+i*3600,100,101,99,100));
 const h4=Array.from({length:8},(_,i)=>candle(Math.floor(start/14400)*14400+i*14400,100,101,99,100));
 const m1=[candle(end+300,100.25,100.3,100.2,100.25)];
 return {m1,m5,h1,h4,setupEpoch:end,setupClose:end+300};
}
test("one-active-trade and duplicate setup gates reject before signal creation",()=>{
 const x=lowVolSetupFixture();
 assert.equal(s.evaluateSetup({...x,nowEpoch:x.setupClose+1,activeTrade:{signalId:"open"}}).reason,"active_trade_exists");
 assert.equal(s.evaluateSetup({...x,nowEpoch:x.setupClose+1,lastSetupEpoch:x.setupEpoch}).reason,"duplicate_setup_candle");
});
test("missing entry candle is skipped and stale entry is recorded, not filled",()=>{
 const x=lowVolSetupFixture();
 const missing=s.evaluateSetup({...x,m1:[candle(x.setupClose+60,100,101,99,100)],nowEpoch:x.setupClose+1});
 assert.equal(missing.reason,"next_entry_candle_unavailable");
 const stale=s.evaluateSetup({...x,nowEpoch:x.setupClose+61});
 assert.equal(stale.reason,"stale_entry");
 assert.equal(stale.status,"SKIPPED");
});
test("frozen setup creates a completed-candle signal with 1R levels and UTC metadata",()=>{
 const x=lowVolSetupFixture();
 const result=s.evaluateSetup({...x,nowEpoch:x.setupClose+5});
 assert.equal(result.status,"GENERATED");
 assert.equal(result.signal.strategyVersion,s.STRATEGY_VERSION);
 assert.equal(result.signal.utcHour,16);
 assert.equal(result.signal.timeframe,"M5");
 assert.ok(Math.abs(Math.abs(result.signal.entry-result.signal.stopLoss)-Math.abs(result.signal.target-result.signal.entry))<1e-9);
 assert.equal(result.signal.brokerExecutionAllowed,false);
});
test("Telegram worker accepts only the new forward-test provider and R10 is excluded at MT5 and queue boundaries",()=>{
 const fs=require("node:fs"),path=require("node:path");
 const worker=fs.readFileSync(path.join(__dirname,"../workers/deriv-telegram-alerts/worker.js"),"utf8");
 const mt5=fs.readFileSync(path.join(__dirname,"../DerivSignalAssistantV2_SignalBridge.mq5"),"utf8");
 const legacy=fs.readFileSync(path.join(__dirname,"../cloudflare/deriv-telegram-alerts.js"),"utf8");
 assert.match(worker,/volatility10_transition_lowvol_1r_forward_v1/);
 assert.match(worker,/VOLATILITY 10 — FORWARD TEST — NO TRADE EXECUTED/);
 assert.match(worker,/data\.brokerExecutionAllowed === false/);
 assert.match(worker,/data\.forwardTest === true/);
 assert.match(worker,/r10-delivery-reserve/);
 assert.match(worker,/R_10 is forward-test-only and cannot enter the broker execution queue/);
 assert.match(worker,/const MT5_ALLOWED_MARKETS=new Set\(\["R_25"/);
 assert.doesNotMatch(mt5,/AllowedMarkets\[\] = \{[^}]*"R_10"/);
 assert.doesNotMatch(mt5,/InpSymbolMap = "[^"]*R_10=/);
 assert.doesNotMatch(legacy,/MT5_ALLOWED_MARKETS=new Set\(\["R_10"/);
});

test("invalid or discontinuous M1 source is not aggregated across a gap",()=>{
 const rows=Array.from({length:12},(_,i)=>candle(i*60,10,11,9,10));
 rows[7]={...rows[7],epoch:rows[7].epoch+60};
 assert.equal(s.validateSeries(rows,s.M1),"data_gap");
 assert.deepEqual(s.aggregateM1(rows,s.M5),[]);
});
test("swing confirmation timestamp is never later than the decision timestamp",()=>{
 const rows=[
  [2,0],[3,1],[6,2],[4,1],[3,0],[4,2],[7,3],[5,2],[4,1],[5,3],[8,4],[6,3],[5,2]
 ].map((v,i)=>candle(i*s.H1,3,v[0],v[1],3));
 const decisionEpoch=13*s.H1;
 const structure=s.classifyStructure(rows,s.H1,decisionEpoch);
 for(const list of [structure.swings.highs,structure.swings.lows])
  for(const swing of list)assert.ok(swing.confirmedAt<=decisionEpoch);
});

test("scanner resumes from the latest contiguous valid M1 segment after gaps or invalid rows",()=>{
 const rows=[0,60,120,240,300,360,420,480].map((epoch,i)=>candle(epoch,10,11,9,10));
 rows[6]={...rows[6],high:8};
 const segment=scanner.latestContinuousSegment(rows);
 assert.deepEqual(segment.map(x=>x.epoch),[480]);
 const gapRows=[0,60,120,240,300,360].map(epoch=>candle(epoch,10,11,9,10));
 assert.deepEqual(scanner.latestContinuousSegment(gapRows).map(x=>x.epoch),[240,300,360]);
});


test("0.20R live quote gate accepts at the boundary and rejects displacement beyond it",()=>{
 const signal={referenceEntryPrice:100,risk:2};
 assert.equal(scanner.validateEntryQuote(signal,{price:100.4,ageSeconds:1}).accepted,true);
 const rejected=scanner.validateEntryQuote(signal,{price:100.4001,ageSeconds:1});
 assert.equal(rejected.accepted,false);
 assert.equal(rejected.reason,"ENTRY_DISPLACEMENT_EXCEEDED");
 assert.ok(rejected.displacementR>0.20);
});
test("0.20R live quote gate fails closed for missing or stale quotes",()=>{
 const signal={referenceEntryPrice:100,risk:2};
 assert.equal(scanner.validateEntryQuote(signal,null).reason,"live_quote_missing_or_stale");
 assert.equal(scanner.validateEntryQuote(signal,{price:100,ageSeconds:6}).reason,"live_quote_missing_or_stale");
});
