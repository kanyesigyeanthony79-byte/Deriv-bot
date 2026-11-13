"use strict";
// Isolated, observation-only multi-timeframe data collector.
// Does not send Telegram messages, place trades, or modify production signal state.
const fs = require("node:fs");
const path = require("node:path");
const { aggregateWeeklyCandles, validCandles, evaluateAllCategories } = require("./multi_timeframe_engine");
const { updateJournal, summarizeJournal } = require("./multi_timeframe_journal");

const PUBLIC = "wss://api.derivws.com/trading/v1/options/ws/public";
const MARKETS = [
  ["R_10", "Volatility 10 Index"], ["R_25", "Volatility 25 Index"],
  ["R_50", "Volatility 50 Index"], ["R_75", "Volatility 75 Index"],
  ["JD100", "Jump 100 Index"], ["frxXAUUSD", "Gold/USD"],
  ["CRASH500", "Crash 500 Index"], ["BOOM500", "Boom 500 Index"]
];
const FRAMES = [
  ["M1", 60, 240], ["M5", 300, 240], ["M15", 900, 240],
  ["H1", 3600, 240], ["H4", 14400, 240], ["D1", 86400, 520]
];
const OUTPUT = path.join(__dirname, "multi_timeframe_data.json");
const JOURNAL = path.join(__dirname, "multi_timeframe_journal.json");
const log = (event, details = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("Connection timed out")); }, 15000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      let nextId = 0;
      const pending = new Map();
      ws.addEventListener("message", ev => {
        let data;
        try { data = JSON.parse(String(ev.data)); } catch { return; }
        const entry = pending.get(data.req_id);
        if (!entry) return;
        pending.delete(data.req_id);
        clearTimeout(entry.timer);
        if (data.error) entry.reject(new Error(data.error.message || "Deriv API error"));
        else entry.resolve(data);
      });
      ws.addEventListener("close", () => {
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error("WebSocket closed before response"));
          pending.delete(id);
        }
      });
      resolve({
        ask(payload, timeoutMs = 25000) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            const timer = setTimeout(() => { pending.delete(id); rej(new Error("Request timed out")); }, timeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ ...payload, req_id: id }));
          });
        },
        close() { try { ws.close(); } catch {} }
      });
    });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket connection error")); }, { once: true });
  });
}

const normalize = value => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
function resolveSymbol(list, fallback, name) {
  const exactName = list.find(x => normalize(x.underlying_symbol_name || x.display_name) === normalize(name));
  const exactCode = list.find(x => (x.underlying_symbol || x.symbol) === fallback);
  const found = exactName || exactCode;
  return found ? (found.underlying_symbol || found.symbol) : null;
}
function normalizeCandles(raw, granularity, now) {
  const candles = (raw || [])
    .map(c => ({ epoch: Number(c.epoch), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
    .filter(c => [c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite))
    .sort((a, b) => a.epoch - b.epoch)
    .filter(c => c.epoch + granularity <= now);
  return validCandles(candles) ? candles : [];
}
async function main() {
  const client = await connect(PUBLIC);
  try {
    const timeReply = await client.ask({ time: 1 });
    const now = Number(timeReply.time) || Math.floor(Date.now() / 1000);
    let symbolsReply = await client.ask({ active_symbols: "brief" });
    let symbols = symbolsReply.active_symbols || [];
    const unresolved = MARKETS.filter(([id, name]) => !resolveSymbol(symbols, id, name));
    if (unresolved.length) {
      symbolsReply = await client.ask({ active_symbols: "full" });
      symbols = [...symbols, ...(symbolsReply.active_symbols || [])];
    }
    const output = {
      version: 1,
      generatedAt: new Date(now * 1000).toISOString(),
      generatedEpoch: now,
      mode: "observation_only",
      markets: {},
      errors: []
    };

    for (const [marketId, marketName] of MARKETS) {
      const symbol = resolveSymbol(symbols, marketId, marketName);
      if (!symbol) {
        const message = "Could not resolve active Deriv symbol.";
        output.errors.push({ marketId, marketName, message });
        log("symbol_not_confirmed", { marketId, marketName });
        continue;
      }
      const marketData = { marketId, marketName, symbol, timeframes: {}, errors: [] };
      // Fetch sequentially per market to avoid bursting the public API.
      for (const [tf, granularity, count] of FRAMES) {
        try {
          const reply = await client.ask({
            ticks_history: symbol, adjust_start_time: 1, count,
            end: "latest", granularity, style: "candles"
          });
          const candles = normalizeCandles(reply.candles, granularity, now);
          marketData.timeframes[tf] = candles;
          if (candles.length < 60) {
            marketData.errors.push({ timeframe: tf, message: "Fewer than 60 completed candles available." });
          }
          log("timeframe_collected", { marketId, timeframe: tf, candles: candles.length });
        } catch (error) {
          marketData.timeframes[tf] = [];
          marketData.errors.push({ timeframe: tf, message: error.message });
          log("timeframe_collection_failed", { marketId, timeframe: tf, message: error.message });
        }
      }
      const daily = marketData.timeframes.D1 || [];
      const weekly = aggregateWeeklyCandles(daily, now);
      marketData.timeframes.W1 = weekly;
      if (weekly.length < 60) {
        marketData.errors.push({ timeframe: "W1", message: "Fewer than 60 completed weekly candles available; position signals will remain warming." });
      }
      // Generate observation-only candidates. No alerts or trade execution.
      marketData.signals = evaluateAllCategories(marketId, marketName, marketData.timeframes);
      output.markets[marketId] = marketData;
    }

    const priorJournal = fs.existsSync(JOURNAL) ? JSON.parse(fs.readFileSync(JOURNAL, "utf8")) : { version: 1, signals: [] };
    const journal = updateJournal(priorJournal, output.markets, now);
    fs.writeFileSync(JOURNAL, JSON.stringify(journal, null, 2) + "\n");
    fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + "\n");
    const total = Object.values(output.markets).reduce((sum, m) =>
      sum + Object.values(m.timeframes).reduce((n, candles) => n + candles.length, 0), 0);
    const allSignals = Object.values(output.markets).flatMap(m => m.signals || []);
    const signalCounts = Object.fromEntries(["signal", "no_signal", "timeframe_conflict", "warming"].map(state =>
      [state, allSignals.filter(s => s.state === state).length]
    ));
    output.summary = { markets: Object.keys(output.markets).length, signalCounts, journal: summarizeJournal(journal) };
    log("collection_complete", {
      markets: Object.keys(output.markets).length,
      candles: total,
      signalCounts,
      errors: output.errors.length + Object.values(output.markets).reduce((n, m) => n + m.errors.length, 0),
      output: "multi_timeframe_data.json"
    });
    if (Object.keys(output.markets).length !== MARKETS.length) process.exitCode = 1;
  } finally {
    client.close();
  }
}
main().catch(error => { log("collector_failed", { message: error.message }); process.exitCode = 1; });
