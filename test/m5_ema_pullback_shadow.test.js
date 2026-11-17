"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {ema,m15Bias,m5Trigger,makeSignal,updateOutcome,updateM5PullbackJournal}=require("../m5_ema_pullback_shadow");
const base=Math.floor(1_700_000_000/900)*900;
function frame(n,step,price=100){return Array.from({length:n},(_,i)=>({epoch:base+i*step,open:price,high:price+0.2,low:price-0.2,close:price}));}
test("M15 bias only returns a direction from completed valid engine signals",()=>{assert.equal(m15Bias(frame(64,900)),null);});
test("M5 trigger requires EMA alignment and EMA9 pullback/reclaim",()=>{const rows=Array.from({length:70},(_,i)=>{const p=100+i*.1;return{epoch:base+i*300,open:p-.05,high:p+.15,low:p-.15,close:p};});const fast=ema(rows.map(c=>c.close),9);rows[69]={...rows[69],open:fast-.1,low:fast-.15,close:fast+.1,high:fast+.15};const t=m5Trigger(rows,"BUY");assert.equal(t.direction,"BUY");});
test("signal enters at next M5 open and targets 2R",()=>{const trigger={direction:"BUY",stop:99,atr5:1,triggerEpoch:base,entryCandleEpoch:base+300};const s=makeSignal("R_10","Volatility 10", "BUY",trigger,{epoch:base+300,open:100});assert.equal(s.entry,100);assert.equal(s.tp2,102);});
test("outcome monitor handles target and stop",()=>{const s={direction:"BUY",entry:100,stopLoss:99,tp2:102,riskDistance:1,entryCandleEpoch:base,lastProcessedEpoch:base-300,status:"pending",outcomeBars:0};updateOutcome(s,[{epoch:base,open:100,high:102.1,low:99.5,close:102}]);assert.equal(s.status,"target");assert.equal(s.realizedR,2);});
test("journal initializes forward-only without backfilling old signals",()=>{const m5=frame(80,300),m15=frame(80,900);const j=updateM5PullbackJournal(null,{R_10:{marketName:"Volatility 10",timeframes:{M5:m5,M15:m15}}},base+50000);assert.equal(j.signals.length,0);assert.equal(j.summary.mode,"forward_shadow_observation_only");});
