const MT5_ALLOWED_MARKETS=new Set(["R_10","R_25","R_50","R_75","JD100","CRASH500","BOOM500"]);
const MT5_MAX_AGE={SCALP:600,SHORT_TERM:1800,POSITION:14400};
function validateMt5Signal(d){
 if(!d||d.event!=="new_signal")return "Only new_signal events can be queued";
 if(!d.signalId||!/^[A-Za-z0-9._:-]{1,120}$/.test(String(d.signalId)))return "Invalid signalId";
 if(!MT5_ALLOWED_MARKETS.has(String(d.marketId||"")))return "Market is not on the synthetic allow-list";
 if(String(d.market||"").toLowerCase().includes("gold"))return "Gold is excluded";
 const dir=String(d.direction||"").toUpperCase();if(dir!=="BUY"&&dir!=="SELL")return "Invalid direction";
 for(const x of ["entry","livePrice","stopLoss","tp1","tp2"])if(!Number.isFinite(Number(d[x])))return "Invalid numeric field: "+x;
 const e=Number(d.entry),sl=Number(d.stopLoss),a=Number(d.tp1),b=Number(d.tp2);
 if(e<=0||sl<=0||a<=0||b<=0)return "Prices must be positive";
 if(dir==="BUY"&&!(sl<e&&a>e&&b>=a))return "BUY levels are inconsistent";
 if(dir==="SELL"&&!(sl>e&&a<e&&b<=a))return "SELL levels are inconsistent";
 if(d.priceValidation!=="PASS")return "Signal price validation did not pass";
 const dev=Number(d.entryDeviationR);if(!Number.isFinite(dev)||dev>0.2)return "Entry deviation exceeds limit";
 const cat=String(d.category||"").toUpperCase();if(!Object.prototype.hasOwnProperty.call(MT5_MAX_AGE,cat))return "Unsupported signal category";
 const age=Number(d.signalAgeSeconds);if(!Number.isFinite(age)||age<0||age>MT5_MAX_AGE[cat])return "Signal is stale";
 return null;
}
export class ExecutionQueue{
 constructor(ctx,env){this.ctx=ctx;}
 async fetch(request){
  const u=new URL(request.url);
  if(request.method==="POST"&&u.pathname==="/enqueue"){
   const payload=await request.json(),id=String(payload.signalId),now=Math.floor(Date.now()/1000);
   const r=await this.ctx.storage.transaction(async t=>{
    const k="signal:"+id,old=await t.get(k);if(old)return {queued:old.status==="pending",duplicate:true,status:old.status};
    await t.put(k,{payload,queuedAt:now,status:"pending",leaseClient:"",leaseUntil:0,ackAt:0,result:null});
    const ids=(await t.get("queue_ids"))||[];ids.push(id);await t.put("queue_ids",ids);return {queued:true,duplicate:false,status:"pending"};
   });return Response.json({success:true,...r});
  }
  if(request.method==="GET"&&u.pathname==="/next"){
   const client=String(u.searchParams.get("clientId")||"");if(!/^[A-Za-z0-9._-]{1,80}$/.test(client))return Response.json({error:"Invalid clientId"},{status:400});
   const now=Math.floor(Date.now()/1000);
   const r=await this.ctx.storage.transaction(async t=>{
    const ids=(await t.get("queue_ids"))||[];
    for(const id of ids){const k="signal:"+id,rec=await t.get(k);if(!rec||rec.status!=="pending")continue;
     const max=MT5_MAX_AGE[String(rec.payload.category||"").toUpperCase()]||0,age=Number(rec.payload.signalAgeSeconds||0)+Math.max(0,now-rec.queuedAt);
     if(!max||age>max){rec.status="expired";rec.ackAt=now;rec.result="expired_before_execution";await t.put(k,rec);continue;}
     if(rec.leaseUntil>now&&rec.leaseClient!==client)return {signal:null,reason:"leased_to_another_client"};
     rec.leaseClient=client;rec.leaseUntil=now+30;await t.put(k,rec);return {signal:rec.payload,queuedAt:rec.queuedAt,signalAgeSeconds:age,leaseUntil:rec.leaseUntil};
    }return {signal:null,reason:"queue_empty"};
   });return Response.json({success:true,...r});
  }
  if(request.method==="POST"&&u.pathname==="/ack"){
   const b=await request.json(),id=String(b.signalId||""),client=String(b.clientId||""),status=String(b.status||"");
   if(!id||!/^[A-Za-z0-9._-]{1,80}$/.test(client)||!["accepted","rejected"].includes(status))return Response.json({error:"Invalid acknowledgement"},{status:400});
   const now=Math.floor(Date.now()/1000);
   const r=await this.ctx.storage.transaction(async t=>{const k="signal:"+id,rec=await t.get(k);if(!rec)return {acknowledged:false,reason:"signal_not_found"};
    if(rec.status!=="pending")return {acknowledged:rec.status===status,status:rec.status,duplicate:true};
    if(rec.leaseClient&&rec.leaseClient!==client)return {acknowledged:false,reason:"lease_owner_mismatch"};
    rec.status=status;rec.ackAt=now;rec.result=String(b.reason||status).slice(0,240);await t.put(k,rec);return {acknowledged:true,status};
   });return Response.json({success:Boolean(r.acknowledged),...r},{status:r.acknowledged?200:409});
  }
  if(request.method==="GET"&&u.pathname==="/health"){const ids=(await this.ctx.storage.get("queue_ids"))||[];let pending=0;for(const id of ids){const x=await this.ctx.storage.get("signal:"+id);if(x&&x.status==="pending")pending++;}return Response.json({success:true,queueDepth:pending});}
  return Response.json({error:"Not found"},{status:404});
 }
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key"
    };
    const reply = (body, status = 200) => Response.json(body, { status, headers: cors });
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST" && request.method !== "GET") return reply({ error: "Method not allowed" }, 405);
    if (!env.SIGNAL_API_KEY) return reply({ error: "Worker secret is not configured" }, 500);
    if (request.headers.get("X-API-Key") !== env.SIGNAL_API_KEY) return reply({ error: "Unauthorized" }, 401);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/mt5/")) {
      if (!env.EXECUTION_QUEUE) return reply({ error: "Execution queue binding is missing" }, 503);
      const q=env.EXECUTION_QUEUE.get(env.EXECUTION_QUEUE.idFromName("global-synthetic-signal-queue"));
      if(url.pathname==="/mt5/ingest"&&request.method==="POST"){const d=await request.json(),reason=validateMt5Signal(d);if(reason)return reply({error:reason},422);const r=await q.fetch("https://queue/enqueue",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)});const v=await r.json();if(!r.ok||!v.success)return reply({error:"Could not enqueue signal"},503);return reply({success:true,message:v.duplicate?"Signal already known":"Signal queued",duplicate:v.duplicate,status:v.status});}
      if(url.pathname==="/mt5/next"&&request.method==="GET"){const r=await q.fetch("https://queue/next?clientId="+encodeURIComponent(url.searchParams.get("clientId")||""));return reply(await r.json(),r.status);}
      if(url.pathname==="/mt5/ack"&&request.method==="POST"){const r=await q.fetch("https://queue/ack",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(await request.json())});return reply(await r.json(),r.status);}
      if(url.pathname==="/mt5/health"&&request.method==="GET"){const r=await q.fetch("https://queue/health");return reply(await r.json(),r.status);}
      return reply({error:"Not found"},404);
    }
    if(request.method!=="POST")return reply({error:"Use POST to submit an alert"},405);
    if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID)return reply({error:"Telegram secrets are not configured"},500);

    try {
      const data = await request.json();
      let message;

      if (data.event === "daily_summary") {
        message = String(data.message || data.text || "").trim();
        if (!message) return reply({ error: "Daily report message is empty" }, 400);
        if (message.length > 3900) return reply({ error: "Daily report is too long" }, 400);
      } else {
        const required = ["market", "direction", "entry", "stopLoss", "tp1", "tp2"];
        for (const field of required) {
          if (data[field] === undefined || data[field] === null || data[field] === "") {
            return reply({ error: `Missing field: ${field}` }, 400);
          }
        }
        const direction = String(data.direction).toUpperCase();
        if (!["BUY", "SELL"].includes(direction)) return reply({ error: "Direction must be BUY or SELL" }, 400);
        for (const field of ["entry", "stopLoss", "tp1", "tp2"]) {
          if (!Number.isFinite(Number(data[field]))) return reply({ error: `Invalid number: ${field}` }, 400);
        }
        const market = String(data.market).slice(0, 80);

        if (data.event === "outcome") {
          const outcomes = {
            TP1_HIT: {
              title: "✅ TAKE PROFIT 1 HIT",
              description: "Price reached the first take-profit level."
            },
            TP2_HIT: {
              title: "✅ TAKE PROFIT 2 HIT",
              description: "Price reached the second take-profit level."
            },
            SL_HIT: {
              title: "❌ STOP LOSS HIT",
              description: "Price reached the stop-loss level."
            },
            SL_AFTER_TP1: {
              title: "⚠️ STOP LOSS HIT AFTER TP1",
              description: "TP1 was reached earlier; price subsequently reached the stop-loss level."
            },
            EXPIRED: {
              title: "⏳ SIGNAL MONITORING EXPIRED",
              description: "The monitoring window ended without a confirmed take-profit or stop-loss outcome."
            },
            AMBIGUOUS: {
              title: "⚠️ OUTCOME AMBIGUOUS",
              description: "The same completed candle crossed both a target and the stop-loss. Intrabar order cannot be confirmed."
            }
          };
          const outcome = outcomes[data.outcome];
          if (!outcome) return reply({ error: "Invalid outcome type" }, 400);
          if (!data.signalId) return reply({ error: "Missing signalId" }, 400);
          const priorityLines = data.priorityTier === "RESEARCH_PRIORITY" ? [
            String(data.priorityLabel || "PRIORITY PAIR — RESEARCH WATCH"),
            "Historical " + String(data.priorityMetricName || "directional follow-through") + ": " +
              Number(data.priorityMetricPct).toFixed(1) + "% (not a strategy win rate)"
          ] : [];
          message = [
            outcome.title,
            ...priorityLines,
            "━━━━━━━━━━━━━━━━",
            `📊 Market: ${market}`,
            `📈 Direction: ${direction}`,
            `🎯 Entry: ${data.entry}`,
            `🛑 Stop Loss: ${data.stopLoss}`,
            `💰 TP1: ${data.tp1}`,
            `💰 TP2: ${data.tp2}`,
            data.currentPrice !== undefined ? `📍 Observed price: ${data.currentPrice}` : null,
            `🔖 Signal: ${String(data.signalId).slice(0, 60)}`,
            "━━━━━━━━━━━━━━━━",
            outcome.description,
            "⚠️ Signal monitoring update, not a trade execution."
          ].filter(Boolean).join("\n");
        } else {
          if (data.event && data.event !== "new_signal") return reply({ error: "Invalid event type" }, 400);
          if (data.event === "new_signal" && !data.signalId) return reply({ error: "Missing signalId" }, 400);
          const priorityLines = data.priorityTier === "RESEARCH_PRIORITY" ? [
            String(data.priorityLabel || "PRIORITY PAIR — RESEARCH WATCH"),
            "Historical " + String(data.priorityMetricName || "directional follow-through") + ": " +
              Number(data.priorityMetricPct).toFixed(1) + "% (not a strategy win rate)"
          ] : [];
          message = [
            "🆕 NEW SIGNAL ALERT",
            ...priorityLines,
            "━━━━━━━━━━━━━━━━",
            `📊 Market: ${market}`,
            `📈 Direction: ${direction}`,
            `🎯 Entry: ${data.entry}`,
            `🛑 Stop Loss: ${data.stopLoss}`,
            `💰 Take Profit 1: ${data.tp1}`,
            `💰 Take Profit 2: ${data.tp2}`,
            data.livePrice !== undefined ? `📍 Live price at alert: ${data.livePrice}` : null,
            data.signalAgeSeconds !== undefined ? `⏱ Signal age: ${Math.round(Number(data.signalAgeSeconds))}s` : null,
            data.priceValidation === "PASS" ? `✅ Entry distance check: PASS (${data.entryDeviationR}R)` : null,
            data.signalId ? `🔖 Signal: ${String(data.signalId).slice(0, 60)}` : null,
            "━━━━━━━━━━━━━━━━",
            "⚠️ Signal only. Verify conditions before trading; no trade is executed automatically."
          ].filter(Boolean).join("\n");
        }
      }

      const telegramURL = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const telegramPayload = { chat_id: env.TELEGRAM_CHAT_ID, text: message };
      // Attach review navigation only to new MTF signal messages that explicitly opt in.
      // Legacy alerts, outcome updates and daily summaries keep their existing layout.
      if (data.event === "new_signal" && data.reviewAvailable === true && data.signalId && env.REVIEW_PAGE_URL) {
        try {
          const reviewUrl = new URL(String(env.REVIEW_PAGE_URL));
          if (reviewUrl.protocol === "https:") {
            reviewUrl.searchParams.set("signalId", String(data.signalId));
            telegramPayload.reply_markup = {
              inline_keyboard: [[{ text: "REVIEW SIGNAL STATUS", url: reviewUrl.toString() }]]
            };
          }
        } catch (error) {
          // Invalid optional review-page configuration must not block signal delivery.
        }
      }
      const telegramResponse = await fetch(telegramURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(telegramPayload)
      });
      const result = await telegramResponse.json();
      if (!telegramResponse.ok || !result.ok) return reply({ error: "Telegram delivery failed" }, 502);
      return reply({ success: true, message: "Telegram alert delivered" });
    } catch (error) {
      return reply({ error: "Invalid request or delivery error" }, 400);
    }
  }
};