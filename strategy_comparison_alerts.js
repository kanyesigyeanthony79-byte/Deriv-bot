"use strict";
const { STRATEGIES } = require("./strategy_comparison");
const TIMEFRAME_SECONDS = 15 * 60;
const MAX_ALERT_AGE_SECONDS = 10 * 60;
const MAX_ENTRY_DEVIATION_R = 0.2;
const TERMINAL = new Set(["tp2_hit", "stopped", "stopped_after_tp1", "ambiguous", "expired"]);
function ugandaDate(epochSeconds) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epochSeconds * 1000));
}
function forwardSignalsNeedingDelivery(journal) {
  return (journal?.signals || []).filter(signal => signal && signal.evaluationSource === "forward_shadow" && signal.signalId && !signal.telegramStatus);
}
function assessShadowEntryPrice(signal, livePrice) {
  const price=Number(livePrice), entry=Number(signal.entry), stop=Number(signal.stopLoss), risk=Math.abs(entry-stop);
  if (![price,entry,stop,risk].every(Number.isFinite) || risk<=0) return {valid:false,reason:"invalid_or_missing_live_price_or_levels"};
  const deviation=Math.abs(price-entry), maxDeviation=risk*MAX_ENTRY_DEVIATION_R;
  const direction=String(signal.direction||"").toUpperCase();
  const targetPassed=direction==="BUY" ? price>=Number(signal.tp1) : direction==="SELL" ? price<=Number(signal.tp1) : false;
  const valid=(direction==="BUY"||direction==="SELL") && deviation<=maxDeviation && !targetPassed;
  return {valid,reason:valid?null:targetPassed?"tp1_already_reached":"live_price_too_far_from_entry",livePrice:price,deviationR:deviation/risk,maxDeviation};
}
function dailyStrategyRows(journal, day) {
  return STRATEGIES.map(strategy => {
    const rows=(journal?.signals||[]).filter(signal=>signal.strategyId===strategy.id&&signal.evaluationSource==="forward_shadow"&&Number.isFinite(Number(signal.entryCandleEpoch))&&ugandaDate(Number(signal.entryCandleEpoch))===day);
    const wins=rows.filter(signal=>signal.status==="tp2_hit").length;
    const losses=rows.filter(signal=>["stopped","stopped_after_tp1"].includes(signal.status)).length;
    const pending=rows.filter(signal=>!TERMINAL.has(signal.status)).length;
    const ambiguous=rows.filter(signal=>signal.status==="ambiguous").length;
    const expired=rows.filter(signal=>signal.status==="expired").length;
    const resolved=wins+losses;
    return {id:strategy.id,label:strategy.label,generated:rows.length,wins,losses,pending,ambiguous,expired,resolved,tp2Rate:resolved?Number((wins/resolved*100).toFixed(1)):null,tp1:rows.filter(signal=>signal.tp1Hit===true).length};
  });
}
function buildDailyStrategyMessage(journal, day) {
  const rows=dailyStrategyRows(journal,day);
  const lines=["M15 STRATEGY SHADOW REPORT — "+day,"DEMO RESEARCH ONLY • NO ORDERS EXECUTED","Same entry/SL/TP rules across all four strategies.",""];
  for(const row of rows){lines.push(row.label);lines.push("Signals: "+row.generated+" | TP2: "+row.wins+" | SL: "+row.losses+" | TP1 touched: "+row.tp1+" | Pending: "+row.pending+" | Ambiguous: "+row.ambiguous+" | Expired: "+row.expired);lines.push("TP2 rate on resolved wins/losses: "+(row.tp2Rate===null?"N/A":row.tp2Rate+"%"));}
  const qualified=rows.filter(row=>row.resolved>=5&&row.tp2Rate!==null).sort((a,b)=>b.tp2Rate-a.tp2Rate);
  lines.push("");lines.push(qualified.length?"Daily leader (minimum 5 resolved signals): "+qualified[0].label+" at "+qualified[0].tp2Rate+"% TP2 ("+qualified[0].resolved+" resolved).":"Daily leader: not assigned; each strategy needs at least 5 resolved signals.");
  lines.push("");lines.push("Pending signals are not counted as wins or losses. Intrabar order can be ambiguous on M15 candles. This is signal-outcome research, not account P/L.");return lines.join("\n");
}
async function postWorker(env,payload,fetchImpl){const response=await fetchImpl(env.TELEGRAM_WORKER_URL,{method:"POST",headers:{"Content-Type":"application/json","X-API-Key":env.SIGNAL_API_KEY},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});const body=await response.json().catch(()=>({}));if(!response.ok||body.success!==true)throw new Error(body.error||("Telegram Worker HTTP "+response.status));}
async function sendStrategyComparisonAlerts(journal,nowEpoch,env,options={}) {
  const log=options.log||(()=>{}),persist=options.persist||(()=>{}),fetchImpl=options.fetchImpl||fetch,liveQuotes=options.liveQuotes||{};
  const result={enabled:false,considered:0,sent:0,stale:0,missed:0,quoteUnavailable:0,failed:0,skipped:0};
  if(env.STRATEGY_COMPARISON_TELEGRAM_ALERTS!=="true"){log("strategy_comparison_telegram_disabled",{reason:"feature_flag_off"});return result;}
  if(!env.TELEGRAM_WORKER_URL||!env.SIGNAL_API_KEY){log("strategy_comparison_telegram_disabled",{reason:"telegram_secrets_missing"});return result;}
  result.enabled=true;
  for(const signal of forwardSignalsNeedingDelivery(journal)){
    result.considered++;
    const closeEpoch=Number(signal.entryCandleEpoch)+TIMEFRAME_SECONDS,age=nowEpoch-closeEpoch;
    if(!Number.isFinite(age)||age<0||age>MAX_ALERT_AGE_SECONDS){signal.telegramStatus="stale";signal.telegramStatusReason="outside_10_minute_shadow_close_based_alert_window";signal.telegramAgeSeconds=age;signal.telegramCandleCloseEpoch=closeEpoch;result.stale++;persist(journal);continue;}
    const quote=liveQuotes[signal.marketId],priceCheck=assessShadowEntryPrice(signal,quote&&quote.price);
    if(!quote||!Number.isFinite(Number(quote.price))){result.quoteUnavailable++;log("shadow_live_quote_unavailable",{signalId:signal.signalId,marketId:signal.marketId});continue;}
    if(!priceCheck.valid){signal.telegramStatus="missed";signal.telegramStatusReason=priceCheck.reason;signal.telegramLivePrice=priceCheck.livePrice;signal.telegramEntryDeviationR=priceCheck.deviationR;signal.telegramCheckedAt=new Date(nowEpoch*1000).toISOString();result.missed++;persist(journal);log("shadow_candidate_missed",{signalId:signal.signalId,...priceCheck});continue;}
    const payload={event:"new_signal",signalId:signal.signalId,market:"SHADOW | "+String(signal.strategyLabel||signal.strategyId)+" | "+String(signal.market||signal.marketId),direction:signal.direction,entry:signal.entry,livePrice:priceCheck.livePrice,stopLoss:signal.stopLoss,tp1:signal.tp1,tp2:signal.tp2,signalAgeSeconds:age,entryTimeframe:"M15",candleCloseEpoch:closeEpoch,entryDeviationR:Number(priceCheck.deviationR.toFixed(3)),priceValidation:"PASS"};
    try{await postWorker(env,payload,fetchImpl);signal.telegramStatus="sent";signal.telegramSentAt=new Date(nowEpoch*1000).toISOString();signal.telegramAgeSeconds=age;signal.telegramCandleCloseEpoch=closeEpoch;signal.telegramLivePrice=priceCheck.livePrice;signal.telegramEntryDeviationR=priceCheck.deviationR;result.sent++;persist(journal);log("strategy_comparison_shadow_delivered",{signalId:signal.signalId,ageSeconds:age,livePrice:priceCheck.livePrice});}
    catch(error){signal.telegramStatus="delivery_failed";signal.telegramStatusReason=String(error.message||error).slice(0,240);signal.telegramAttemptedAt=new Date(nowEpoch*1000).toISOString();result.failed++;persist(journal);log("strategy_comparison_shadow_delivery_failed",{signalId:signal.signalId,message:signal.telegramStatusReason});}
  }
  return result;
}
async function sendDailyStrategyComparisonReport(journal,nowEpoch,env,options={}) {
  const log=options.log||(()=>{}),persist=options.persist||(()=>{}),fetchImpl=options.fetchImpl||fetch;
  const result={enabled:false,sent:false,day:null,reason:null};
  if(env.STRATEGY_COMPARISON_TELEGRAM_ALERTS!=="true"){result.reason="feature_flag_off";return result;}
  if(!env.TELEGRAM_WORKER_URL||!env.SIGNAL_API_KEY){result.reason="telegram_secrets_missing";return result;}
  const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Kampala",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(nowEpoch*1000));
  const hour=Number(parts.find(part=>part.type==="hour")?.value),minute=Number(parts.find(part=>part.type==="minute")?.value);
  if(hour!==0||minute>10){result.reason="not_day_end";return result;}
  result.enabled=true;const day=ugandaDate(nowEpoch-24*60*60);result.day=day;journal.dailyStrategyReports||={};
  if(journal.dailyStrategyReports[day]){result.reason="already_sent_or_attempted";return result;}
  const message=buildDailyStrategyMessage(journal,day);
  try{await postWorker(env,{event:"daily_summary",message,text:message},fetchImpl);journal.dailyStrategyReports[day]={status:"sent",sentAt:new Date(nowEpoch*1000).toISOString()};result.sent=true;persist(journal);log("strategy_comparison_daily_report_sent",{day});}
  catch(error){journal.dailyStrategyReports[day]={status:"delivery_failed",attemptedAt:new Date(nowEpoch*1000).toISOString(),reason:String(error.message||error).slice(0,240)};result.reason="delivery_failed";persist(journal);log("strategy_comparison_daily_report_failed",{day,message:String(error.message||error)});}
  return result;
}
module.exports={ugandaDate,forwardSignalsNeedingDelivery,dailyStrategyRows,buildDailyStrategyMessage,sendStrategyComparisonAlerts,sendDailyStrategyComparisonReport,MAX_ALERT_AGE_SECONDS,assessShadowEntryPrice};
