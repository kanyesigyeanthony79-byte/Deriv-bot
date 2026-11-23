"use strict";

// Volatility 10 M1 paper scanner. This process never places orders.
// It polls during a short-lived runner window; workflow scheduling is not a
// hard real-time guarantee, so candle gaps are recorded and skipped.
const fs = require("node:fs");
const path = require("node:path");
const {
  PROVIDER_ID, evaluateSignal, indicators, evaluateExit
} = require("./volatility10_ema_atr_slope20");

const STATE_PATH = path.join(process.cwd(), "volatility10_paper_state.json");
const JOURNAL_PATH = path.join(process.cwd(), "volatility10_paper_journal.json");
const PUBLIC = "wss://api.derivws.com/trading/v1/options/ws/public";
const RUN_SECONDS = Math.min(265, Math.max(30, Number(process.env.R10_PAPER_RUN_SECONDS || 255)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(PUBLIC);
    let reqId = 0;
    const pending = new Map();
    ws.addEventListener("open", () => resolve({
      ask(payload, timeoutMs = 20000) {
        return new Promise((res, rej) => {
          const id = ++reqId;
          const timer = setTimeout(() => { pending.delete(id); rej(new Error("Deriv request timeout")); }, timeoutMs);
          pending.set(id, {res, rej, timer});
          ws.send(JSON.stringify({...payload, req_id:id}));
        });
      },
      close() { try { ws.close(); } catch {} }
    }));
    ws.addEventListener("message", event => {
      let data;
      try { data = JSON.parse(String(event.data)); } catch { return; }
      const item = pending.get(data.req_id);
      if (!item) return;
      pending.delete(data.req_id);
      clearTimeout(item.timer);
      if (data.error) item.rej(new Error(data.error.message || "Deriv API error"));
      else item.res(data);
    });
    ws.addEventListener("error", () => reject(new Error("Deriv WebSocket connection failed")), {once:true});
  });
}
function splitCandleHistory(rows, now) {
  const completed = rows.filter(c => c.epoch + 60 <= now);
  const nextCandle = rows.find(c => c.epoch + 60 > now) || null;
  return {completed,nextCandle};
}
async function collect(client) {
  const timeReply = await client.ask({time:1});
  const now = Number(timeReply.time) || Math.floor(Date.now()/1000);
  const reply = await client.ask({
    ticks_history:"R_10", adjust_start_time:1, count:1200,
    end:"latest", granularity:60, style:"candles"
  });
  const rows = (reply.candles || []).map(c => ({
    epoch:Number(c.epoch), open:Number(c.open), high:Number(c.high), low:Number(c.low), close:Number(c.close)
  })).filter(c => [c.epoch,c.open,c.high,c.low,c.close].every(Number.isFinite))
    .sort((a,b)=>a.epoch-b.epoch);
  return {now, ...splitCandleHistory(rows,now)};
}
async function deliverPaperSignal(signal) {
  if (process.env.R10_PAPER_TELEGRAM_ENABLED !== "true") return {sent:false,reason:"telegram_flag_off"};
  const url = String(process.env.TELEGRAM_WORKER_URL || "").replace(/\/+$/,"");
  const key = process.env.SIGNAL_API_KEY;
  if (!url || !key) return {sent:false,reason:"worker_secrets_missing"};
  const payload = {
    event:"new_signal", ...signal, marketId:"R_10", market:"Volatility 10 Index",
    direction:signal.direction, status:"PAPER", paper:true, live:false
  };
  const response = await fetch(url,{method:"POST",headers:{"Content-Type":"application/json","X-API-Key":key},
    body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
  const body = await response.json().catch(()=>({}));
  if (!response.ok || body.success !== true) throw new Error(body.error || "Paper Telegram route failed");
  return {sent:true};
}
function processNewCandles(state, journal, completed, nextCandle, nowEpoch) {
  if (!completed.length) return;
  const latest = completed[completed.length - 1];
  if (state.lastProcessedEpoch === null || state.lastProcessedEpoch === undefined) {
    // Warm-up is not backtested into the forward journal. Start observing from now.
    state.lastProcessedEpoch = latest.epoch;
    state.lastCompletedEpoch = latest.epoch;
    return;
  }
  const ind = indicators(completed);
  for (let i=0;i<completed.length;i++) {
    const candle = completed[i];
    if (candle.epoch <= state.lastProcessedEpoch) continue;
    if (state.activePosition && candle.epoch >= state.activePosition.entryEpoch &&
        candle.epoch > state.activePosition.lastEvaluatedEpoch) {
      const position = state.activePosition;
      position.barsHeld += 1;
      const entryIndex = i - position.barsHeld + 1;
      const exit = evaluateExit({
        direction:position.direction, stopLoss:position.stopLoss,
        takeProfit:position.takeProfit, entryIndex
      }, candle, ind, i);
      position.lastEvaluatedEpoch = candle.epoch;
      if (exit) {
        state.closedPositions.push({
          ...position, exitReason:exit.reason, exitPrice:exit.exitPrice,
          exitEpoch:candle.epoch, closedAt:new Date(candle.epoch*1000).toISOString(),
          paper:true, live:false
        });
        state.activePosition = null;
      }
    }
    if (!state.activePosition) {
      const next = completed[i+1] || (candle.epoch === latest.epoch ? nextCandle : null);
      if (!next) continue;
      const history = completed.slice(0,i+1);
      const result = evaluateSignal(history,next,{lastSignalEpoch:state.lastSignalEpoch});
      if (!result.signal) continue;
      const signal = result.signal;
      state.lastSignalEpoch = signal.signalEpoch;
      state.activePosition = {
        direction:signal.direction, entryPrice:signal.referenceEntryPrice,
        entryEpoch:Math.floor(new Date(signal.entryTimestamp).getTime()/1000),
        stopLoss:signal.stopLoss,takeProfit:signal.takeProfit,barsHeld:0,
        lastEvaluatedEpoch:candle.epoch,signalEpoch:signal.signalEpoch
      };
      const signalRecord = {...signal,telegram:null};
      journal.signals.push(signalRecord);
      const signalAge = Number(nowEpoch) - signal.signalEpoch;
      if (signalAge <= 60 && signalAge >= 0) {
        // The worker independently enforces provider identity, paper status and kill switch.
        deliverPaperSignal(signal).then(result => {
          signalRecord.telegram = result;
          writeJson(JOURNAL_PATH,journal);
        }).catch(error => {
          signalRecord.telegram = {sent:false,reason:String(error.message||error)};
          writeJson(JOURNAL_PATH,journal);
        });
      } else {
        signalRecord.telegram = {sent:false,reason:"historical_catchup_not_delivered"};
      }
      console.log(JSON.stringify({event:"r10_paper_signal",providerId:PROVIDER_ID,direction:signal.direction,signalTimestamp:signal.signalTimestamp,delayed:signalAge>60}));
    }
  }
  state.lastProcessedEpoch = latest.epoch;
  state.lastCompletedEpoch = latest.epoch;
}
async function main() {
  const enabled = process.env.R10_PAPER_PROVIDER_ENABLED === "true";
  const killed = process.env.R10_EMERGENCY_KILL_SWITCH !== "false";
  if (!enabled || killed) {
    console.log(JSON.stringify({event:"r10_paper_scanner_disabled",providerId:PROVIDER_ID,enabled,killed,liveExecution:false}));
    return;
  }
  const state = readJson(STATE_PATH,{version:1,providerId:PROVIDER_ID,lastSignalEpoch:null,activePosition:null,closedPositions:[],lastCompletedEpoch:null,lastProcessedEpoch:null});
  const journal = readJson(JOURNAL_PATH,{version:1,providerId:PROVIDER_ID,signals:[],health:[]});
  const started = Date.now();
  const client = await connect();
  try {
    while ((Date.now()-started)/1000 < RUN_SECONDS) {
      const snapshot = await collect(client);
      if (snapshot.completed.length < 1050 || !snapshot.nextCandle) {
        journal.health.push({at:new Date().toISOString(),status:"warming_or_current_candle_unavailable",completedCandles:snapshot.completed.length});
      } else {
        const latest = snapshot.completed[snapshot.completed.length-1];
        if (state.lastCompletedEpoch && latest.epoch-state.lastCompletedEpoch > 60) {
          journal.health.push({at:new Date().toISOString(),status:"missed_completed_candle",gapSeconds:latest.epoch-state.lastCompletedEpoch});
        }
        processNewCandles(state,journal,snapshot.completed,snapshot.nextCandle,snapshot.now);
        journal.health.push({at:new Date().toISOString(),status:"healthy",latestCompletedEpoch:latest.epoch,completedCandles:snapshot.completed.length,activePosition:Boolean(state.activePosition)});
      }
      journal.health = journal.health.slice(-500);
      journal.signals = journal.signals.slice(-1000);
      state.closedPositions = state.closedPositions.slice(-1000);
      writeJson(STATE_PATH,state);
      writeJson(JOURNAL_PATH,journal);
      await sleep(5000);
    }
  } finally {
    client.close();
  }
  console.log(JSON.stringify({event:"r10_paper_scanner_window_complete",providerId:PROVIDER_ID,liveExecution:false}));
}
if (require.main === module) main().catch(error=>{console.error(JSON.stringify({event:"r10_paper_scanner_failed",message:error.message}));process.exitCode=1;});
module.exports={collect,splitCandleHistory,processNewCandles};
