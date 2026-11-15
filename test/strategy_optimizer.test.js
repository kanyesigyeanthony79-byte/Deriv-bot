"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const {mergeCandleArchive,configs,buildFeatures,passes,outcome,researchMarket}=require("../strategy_optimizer");
function candles(n=260){return Array.from({length:n},(_,i)=>{const close=100+i*0.08+Math.sin(i/4)*0.2;return {epoch:1700000000+i*900,open:close-0.05,high:close+0.15,low:close-0.15,close};});}
test("archive merges by epoch and keeps sorted unique completed candles",()=>{const cs=candles(10);const a=mergeCandleArchive(null,{R_10:{timeframes:{M15:cs}}});const b=mergeCandleArchive(a,{R_10:{timeframes:{M15:[cs[9],{...cs[9],close:cs[9].close+0.01}]}}});assert.equal(b.markets.R_10.length,10);assert.equal(new Set(b.markets.R_10.map(x=>x.epoch)).size,10);assert.ok(b.markets.R_10[9].close>cs[9].close);});
test("candidate grid is deterministic and broad",()=>{assert.equal(configs().length,162);assert.equal(configs()[0].id,"RULE_001");});
test("feature builder warms up and identifies directional features",()=>{const f=buildFeatures(candles());assert.equal(f[63],null);assert.equal(f.length,260);assert.ok(f[100].atr>0);});
test("outcome enters on next candle and flags same-bar stop-target ambiguity",()=>{const cs=candles(100),f=buildFeatures(cs);const i=70;f[i]={...f[i],direction:"BUY",atr:1};cs[i+1]={...cs[i+1],open:100,high:104,low:97};const o=outcome(cs,f,i);assert.equal(o.status,"ambiguous");});
test("research reports discovery and held-out validation separately",()=>{const r=researchMarket(candles(300));assert.equal(r.configsTested,162);assert.ok(r.status==="research_complete"||r.status==="insufficient_continuous_history");assert.ok(Array.isArray(r.validationOfDiscovery));});
