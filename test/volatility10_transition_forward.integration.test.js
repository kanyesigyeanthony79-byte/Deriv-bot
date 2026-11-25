"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

class MemoryStorage{
 constructor(){this.values=new Map();}
 async get(k){return this.values.get(k);}
 async put(k,v){this.values.set(k,v);}
 async delete(k){return this.values.delete(k);}
 async transaction(fn){return fn(this);}
}
function makeQueue(module){
 const storage=new MemoryStorage();
 const durableObject=new module.ExecutionQueue({storage},{});
 // Cloudflare DurableObjectStub.fetch converts string URLs into Request objects.
 return {fetch(input,init){return durableObject.fetch(input instanceof Request?input:new Request(input,init));}};
}
test("integration: frozen R10 signal reaches Telegram once and is rejected by MT5 and order queue",async()=>{
 const source=fs.readFileSync(path.join(__dirname,"../workers/deriv-telegram-alerts/worker.js"),"utf8");
 const module=await import("data:text/javascript;base64,"+Buffer.from(source).toString("base64"));
 const queue=makeQueue(module);
 const binding={idFromName:()=> "global-synthetic-signal-queue",get:()=>queue};
 const env={
  SIGNAL_API_KEY:"test-only-key",TELEGRAM_BOT_TOKEN:"test-token",TELEGRAM_CHAT_ID:"test-chat",
  EXECUTION_QUEUE:binding,R10_PAPER_ROUTE_ENABLED:"true",R10_EMERGENCY_KILL_SWITCH:"false",
  R10_LEGACY_ROLLBACK_ENABLED:"false",MT5_OBSERVATION_ENABLED:"true",MT5_EXECUTION_ENABLED:"false"
 };
 const signal={
  event:"new_signal",signalId:"R10-TF-1767282900-BUY",marketId:"R_10",market:"Volatility 10 Index",
  direction:"BUY",signalTimestamp:"2026-01-01T16:00:00.000Z",entry:100,stopLoss:98,target:102,
  h4Structure:"NEUTRAL",h1Structure:"BULLISH",m5Setup:{sweepExtreme:99.5,bodyAtr:0.86},
  atr14:0.52,atrPercentile:0.2,utcHour:16,strategyVersion:"volatility10_transition_lowvol_1r_forward_v1",
  providerId:"volatility10_transition_lowvol_1r_forward_v1",timeframe:"M5",status:"PAPER",paper:true,
  live:false,forwardTest:true,brokerExecutionAllowed:false,historicalCatchup:false
 };
 const originalFetch=global.fetch;
 let telegramCalls=0,lastTelegramText="";
 global.fetch=async(url,init)=>{
  telegramCalls++;
  lastTelegramText=JSON.parse(init.body).text;
  return new Response(JSON.stringify({ok:true}),{status:200,headers:{"Content-Type":"application/json"}});
 };
 try{
  const request=()=>new Request("https://worker.example/",{
   method:"POST",headers:{"Content-Type":"application/json","X-API-Key":"test-only-key"},
   body:JSON.stringify(signal)
  });
  const delivered=await module.default.fetch(request(),env);
  assert.equal(delivered.status,200);
  assert.equal((await delivered.json()).success,true);
  assert.equal(telegramCalls,1);
  assert.match(lastTelegramText,/VOLATILITY 10 — FORWARD TEST — NO TRADE EXECUTED/);
  assert.match(lastTelegramText,/No broker order was placed, queued, authorized, or executed/);
  const duplicate=await module.default.fetch(request(),env);
  assert.equal(duplicate.status,200);
  assert.equal((await duplicate.json()).duplicate,true);
  assert.equal(telegramCalls,1,"idempotency prevents a second Telegram send");

  const mt5=await module.default.fetch(new Request("https://worker.example/mt5/ingest",{
   method:"POST",headers:{"Content-Type":"application/json","X-API-Key":"test-only-key"},
   body:JSON.stringify(signal)
  }),env);
  assert.equal(mt5.status,422);
  assert.match((await mt5.json()).error,/allow-list/);

  const directQueue=await queue.fetch(new Request("https://queue/enqueue",{
   method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(signal)
  }));
  assert.equal(directQueue.status,403);
  assert.match((await directQueue.json()).error,/cannot enter the broker execution queue/);
 }finally{global.fetch=originalFetch;}
});

test("legacy strategy rollback remains paper-only and is still blocked by the emergency kill switch",async()=>{
 const source=fs.readFileSync(path.join(__dirname,"../workers/deriv-telegram-alerts/worker.js"),"utf8");
 const module=await import("data:text/javascript;base64,"+Buffer.from(source).toString("base64"));
 const env={SIGNAL_API_KEY:"test-key",TELEGRAM_BOT_TOKEN:"token",TELEGRAM_CHAT_ID:"chat",
  R10_LEGACY_ROLLBACK_ENABLED:"true",R10_PAPER_ROUTE_ENABLED:"true",R10_EMERGENCY_KILL_SWITCH:"false"};
 const legacy={event:"new_signal",marketId:"R_10",market:"Volatility 10 Index",
  instrument:"Volatility 10 Index",timeframe:"M1",direction:"LONG",
  signalTimestamp:"2026-01-01T16:00:00.000Z",strategyVersion:"volatility10_ema_atr_slope20_v1",
  ema12:101,ema26:100,ema100:99,atr14:2,referenceEntryPrice:100,stopLoss:94,takeProfit:106,
  providerId:"volatility10_ema_atr_slope20_v1",status:"PAPER",paper:true,live:false};
 const originalFetch=global.fetch;let sent=0,last="";
 global.fetch=async(url,init)=>{sent++;last=JSON.parse(init.body).text;return new Response(JSON.stringify({ok:true}),{status:200});};
 try{
  const req=()=>new Request("https://worker.example/",{method:"POST",
   headers:{"Content-Type":"application/json","X-API-Key":"test-key"},body:JSON.stringify(legacy)});
  const delivered=await module.default.fetch(req(),env);
  assert.equal(delivered.status,200);assert.equal((await delivered.json()).success,true);
  assert.match(last,/LEGACY ROLLBACK — PAPER SIGNAL/);assert.equal(sent,1);
  const killed=await module.default.fetch(req(),{...env,R10_EMERGENCY_KILL_SWITCH:"true"});
  assert.equal((await killed.json()).suppressed,true);assert.equal(sent,1);
 }finally{global.fetch=originalFetch;}
});
