"use strict";
const fs=require("node:fs");
const path=require("node:path");
const strategy=require("./volatility10_transition_forward");
const STATE_PATH=path.join(process.cwd(),"volatility10_transition_forward_state.json");
const JOURNAL_PATH=path.join(process.cwd(),"volatility10_transition_forward_journal.json");
const PUBLIC="wss://api.derivws.com/trading/v1/options/ws/public";
const RUN_SECONDS=Math.min(265,Math.max(30,Number(process.env.R10_PAPER_RUN_SECONDS||255)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const readJson=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return fallback;}};
const writeJson=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+"\n");
function connect(){
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(PUBLIC);let reqId=0;const pending=new Map();
  ws.addEventListener("open",()=>resolve({
   ask(payload,timeoutMs=20000){return new Promise((res,rej)=>{
    const id=++reqId,timer=setTimeout(()=>{pending.delete(id);rej(new Error("Deriv request timeout"));},timeoutMs);
    pending.set(id,{res,rej,timer});ws.send(JSON.stringify({...payload,req_id:id}));
   });},
   close(){try{ws.close();}catch{}}
  }));
  ws.addEventListener("message",event=>{
   let data;try{data=JSON.parse(String(event.data));}catch{return;}
   const item=pending.get(data.req_id);if(!item)return;
   pending.delete(data.req_id);clearTimeout(item.timer);
   if(data.error)item.rej(new Error("Deriv API request failed: "+String(data.error.code||"unknown")));
   else item.res(data);
  });
  ws.addEventListener("error",()=>reject(new Error("Deriv WebSocket connection failed")),{once:true});
 });
}
function latestContinuousSegment(rows,step=60){
 if(!Array.isArray(rows)||!rows.length)return [];
 let start=0;
 for(let i=0;i<rows.length;i++){
  if(!strategy.validCandle(rows[i])){start=i+1;continue;}
  if(i>0&&(!strategy.validCandle(rows[i-1])||Number(rows[i].epoch)-Number(rows[i-1].epoch)!==step))start=i;
 }
 return rows.slice(start).filter(strategy.validCandle);
}
function splitCandles(rows,nowEpoch){
 const sorted=rows.map(c=>({epoch:Number(c.epoch),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)}))
  .filter(strategy.validCandle).sort((a,b)=>a.epoch-b.epoch);
 return {completed:sorted.filter(c=>c.epoch+60<=nowEpoch),forming:sorted.find(c=>c.epoch+60>nowEpoch)||null};
}
async function collect(client){
 const t=await client.ask({time:1});
 const nowEpoch=Number(t.time);
 if(!Number.isFinite(nowEpoch))throw new Error("Deriv server UTC time unavailable");
 const [r,q]=await Promise.all([
  client.ask({ticks_history:"R_10",adjust_start_time:1,count:5000,end:"latest",granularity:60,style:"candles"}),
  client.ask({ticks_history:"R_10",adjust_start_time:1,count:1,end:"latest",style:"ticks"})
 ]);
 const split=splitCandles(r.candles||[],nowEpoch);
 const quoteTime=Number(q.history?.times?.[0]),quotePrice=Number(q.history?.prices?.[0]);
 const quote={price:Number.isFinite(quotePrice)?quotePrice:null,epoch:Number.isFinite(quoteTime)?quoteTime:null,
  ageSeconds:Number.isFinite(quoteTime)?Math.max(0,nowEpoch-quoteTime):null};
 return {nowEpoch,...split,quote};
}
async function deliverForwardSignal(signal,env=process.env){
 if(env.R10_PAPER_TELEGRAM_ENABLED!=="true")return {sent:false,reason:"telegram_flag_off"};
 if(env.R10_PAPER_ROUTE_ENABLED!=="true")return {sent:false,reason:"telegram_route_flag_off"};
 const url=String(env.TELEGRAM_WORKER_URL||"").replace(/\/+$/,""),key=env.SIGNAL_API_KEY;
 if(!url||!key)return {sent:false,reason:"worker_credentials_missing"};
 const payload={
  event:"new_signal",...signal,timeframe:"M5",entry:signal.entry,target:signal.target,
  status:"PAPER",paper:true,live:false,forwardTest:true,brokerExecutionAllowed:false,historicalCatchup:false
 };
 const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json","X-API-Key":key},
  body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
 const body=await response.json().catch(()=>({}));
 if(!response.ok||body.success!==true)throw new Error("R10 Telegram route rejected delivery");
 return {sent:true,duplicate:Boolean(body.duplicate),deliveredAt:new Date().toISOString()};
}
function validateEntryQuote(signal,quote,maxDisplacementR=0.20,maxAgeSeconds=5){
 if(!quote||!Number.isFinite(quote.price)||!Number.isFinite(quote.ageSeconds)||quote.ageSeconds>maxAgeSeconds)
  return {accepted:false,reason:"live_quote_missing_or_stale",displacementR:null};
 const displacementR=Math.abs(quote.price-signal.referenceEntryPrice)/signal.risk;
 if(!Number.isFinite(displacementR)||displacementR>maxDisplacementR)
  return {accepted:false,reason:"ENTRY_DISPLACEMENT_EXCEEDED",displacementR};
 return {accepted:true,reason:"within_entry_displacement_limit",displacementR};
}
function journalRecord(setupEpoch,result,nowEpoch){
 const signal=result.signal||{};
 return {
  strategyVersion:strategy.STRATEGY_VERSION,signalId:signal.signalId||"R10-TF-"+setupEpoch+"-SKIP",
  marketId:"R_10",market:"Volatility 10 Index",timestampUTC:new Date((setupEpoch+300)*1000).toISOString(),
  direction:signal.direction||null,h4Structure:signal.h4Structure||result.h4Structure?.direction||null,
  h1Structure:signal.h1Structure||result.h1Structure?.direction||null,m5Setup:signal.m5Setup||null,
  atr14:signal.atr14??result.atrValue??null,atrPercentile:signal.atrPercentile??result.atrPercentile??null,
  spread:signal.spread??null,quoteAgeSeconds:signal.quoteAgeSeconds??null,
  entry:signal.entry??null,entryTimestampUTC:signal.entryTimestamp??null,
  entryDelaySeconds:signal.entryDelaySeconds??result.entryDelaySeconds??null,
  stopLoss:signal.stopLoss??null,target:signal.target??null,utcHour:signal.utcHour??null,
  dataSource:signal.dataSource??null,paper:true,live:false,brokerExecutionAllowed:false,
  deliveryStatus:"NOT_SENT",outcome:null,exitTimestampUTC:null,exitPrice:null,outcomeReason:null,
  dataGap:false,stale:result.reason==="stale_entry",
  invalid:typeof result.reason==="string"&&(result.reason.includes("invalid")||result.reason==="stop_not_on_correct_side"),
  ambiguous:false,status:result.status,reason:result.reason||"generated",
  recordedAtUTC:new Date(nowEpoch*1000).toISOString(),errorDetails:null
 };
}
function updateActiveOutcome(state,journal,completedM1){
 if(!state.activeTrade)return;
 const signal=state.activeTrade;
 const result=strategy.resolveM1Outcome(signal,completedM1.filter(c=>Number(c.epoch)>=Number(signal.entryEpoch)));
 if(result.outcome==="PENDING")return;
 const record=journal.signals.find(x=>x.signalId===signal.signalId);
 if(record){
  record.outcome=result.outcome;record.outcomeReason=result.reason;
  record.exitTimestampUTC=result.exitEpoch==null?null:new Date(result.exitEpoch*1000).toISOString();
  record.exitPrice=result.exitPrice;record.ambiguous=result.outcome==="AMBIGUOUS";
  record.dataGap=result.outcome==="UNRESOLVED";record.status=result.outcome;
 }
 state.closedTrades.push({...signal,...result});
 state.activeTrade=null;
}
async function processSnapshot(state,journal,snapshot,env=process.env){
 const {nowEpoch,completed,forming,quote}=snapshot;
 journal.strategyVersion=strategy.STRATEGY_VERSION;
 journal.marketId="R_10";
 updateActiveOutcome(state,journal,completed);
 const continuous=latestContinuousSegment(completed);
 if(continuous.length<2700){
  journal.health.push({at:new Date(nowEpoch*1000).toISOString(),status:"warming_up_or_data_gap",continuousM1Candles:continuous.length});
  return;
 }
 const m5=strategy.aggregateM1(continuous,strategy.M5);
 const h1=strategy.aggregateM1(continuous,strategy.H1);
 const h4=strategy.aggregateM1(continuous,strategy.H4);
 if(!m5.length||!h1.length||!h4.length){
  journal.health.push({at:new Date(nowEpoch*1000).toISOString(),status:"higher_timeframe_warmup"});
  return;
 }
 const allM1=forming?[...completed,forming]:completed;
 const latest=m5[m5.length-1];
 if(state.lastSetupEpoch===null||state.lastSetupEpoch===undefined){
  state.lastSetupEpoch=Number(latest.epoch);
  journal.startedAt=journal.startedAt||new Date(nowEpoch*1000).toISOString();
  journal.health.push({at:new Date(nowEpoch*1000).toISOString(),status:"forward_cursor_initialized_no_historical_catchup",lastSetupEpoch:state.lastSetupEpoch});
  return;
 }
 const firstNew=m5.findIndex(c=>Number(c.epoch)>Number(state.lastSetupEpoch));
 if(firstNew<0)return;
 for(let i=firstNew;i<m5.length;i++){
  const candle=m5[i],setupEpoch=Number(candle.epoch);
  if(setupEpoch<=Number(state.lastSetupEpoch))continue;
  const result=strategy.evaluateSetup({
   m1:allM1,m5:m5.slice(0,i+1),h1,h4,nowEpoch,
   activeTrade:state.activeTrade,lastSetupEpoch:null
  });
  const rec=journalRecord(setupEpoch,result,nowEpoch);
  journal.signals.push(rec);
  state.lastSetupEpoch=setupEpoch;
  if(result.status!=="GENERATED")continue;
  const signal=result.signal;
  // Fail closed unless a fresh Deriv tick confirms the reference entry is still within 0.20R.
  const quoteGate=validateEntryQuote(signal,quote);
  rec.quotePrice=quote?.price??null;rec.quoteAgeSeconds=quote?.ageSeconds??null;
  rec.entryDisplacementR=quoteGate.displacementR;
  if(!quoteGate.accepted){
   rec.status="SKIPPED";rec.reason=quoteGate.reason;rec.deliveryStatus="NOT_SENT";continue;
  }
  signal.quotePrice=quote.price;signal.quoteAgeSeconds=quote.ageSeconds;signal.entryDisplacementR=quoteGate.displacementR;
  // Only the just-closed setup can be delivered. Historical catch-up is journal-only.
  if(nowEpoch-signal.signalEpoch>strategy.MAX_ENTRY_DELAY_SECONDS){
   rec.status="SKIPPED";rec.reason="historical_catchup_not_delivered";rec.stale=true;
   rec.deliveryStatus="NOT_SENT";continue;
  }
  if(state.activeTrade){rec.status="SKIPPED";rec.reason="active_trade_exists";continue;}
  state.activeTrade=signal;
  try{
   const delivery=await deliverForwardSignal(signal,env);
   rec.deliveryStatus=delivery.sent?"SENT":"NOT_SENT";
   rec.deliveryDetails=delivery;
  }catch(error){
   rec.deliveryStatus="FAILED";rec.errorDetails=String(error.message||"delivery_error").slice(0,240);
  }
 }
 journal.signals=journal.signals.slice(-5000);
 journal.health=journal.health.slice(-500);
 state.closedTrades=state.closedTrades.slice(-1000);
}
async function main(){
 const enabled=process.env.R10_PAPER_PROVIDER_ENABLED==="true";
 const killed=process.env.R10_EMERGENCY_KILL_SWITCH!=="false";
 if(!enabled||killed){
  console.log(JSON.stringify({event:"r10_transition_scanner_disabled",enabled,killed,brokerExecution:false}));
  return;
 }
 const state=readJson(STATE_PATH,{version:1,strategyVersion:strategy.STRATEGY_VERSION,lastSetupEpoch:null,activeTrade:null,closedTrades:[]});
 const journal=readJson(JOURNAL_PATH,{version:1,strategyVersion:strategy.STRATEGY_VERSION,marketId:"R_10",startedAt:null,signals:[],health:[]});
 const client=await connect(),started=Date.now();
 try{
  while((Date.now()-started)/1000<RUN_SECONDS){
   try{
    const snapshot=await collect(client);
    await processSnapshot(state,journal,snapshot,process.env);
    writeJson(STATE_PATH,state);writeJson(JOURNAL_PATH,journal);
   }catch(error){
    journal.health.push({at:new Date().toISOString(),status:"collector_error",error:String(error.message||"collector_error").slice(0,240)});
    writeJson(JOURNAL_PATH,journal);
   }
   await sleep(5000);
  }
 }finally{client.close();}
 console.log(JSON.stringify({event:"r10_transition_scanner_window_complete",strategyVersion:strategy.STRATEGY_VERSION,brokerExecution:false}));
}
if(require.main===module)main().catch(error=>{
 console.error(JSON.stringify({event:"r10_transition_scanner_failed",error:String(error.message||"scanner_error").slice(0,240)}));
 process.exitCode=1;
});
module.exports={connect,latestContinuousSegment,splitCandles,collect,deliverForwardSignal,validateEntryQuote,journalRecord,updateActiveOutcome,processSnapshot};
