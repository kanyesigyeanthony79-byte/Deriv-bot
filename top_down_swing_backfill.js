"use strict";

// One-off historical OHLC backfill for the isolated swing experiment.
// Public market data only. Does not send alerts, commit files, or place trades.
const fs = require("node:fs");
const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const MARKETS = [
  ["R_10", "Volatility 10 Index"], ["R_25", "Volatility 25 Index"],
  ["R_50", "Volatility 50 Index"], ["R_75", "Volatility 75 Index"],
  ["JD100", "Jump 100 Index"], ["frxXAUUSD", "Gold/USD"],
  ["CRASH500", "Crash 500 Index"], ["BOOM500", "Boom 500 Index"]
];
// M5 history spans >8 days, permitting a 7-day forward outcome window for
// earlier entries. Higher frames provide several months/years of swing context.
const FRAMES = [
  ["M5", 300, 2500], ["M15", 900, 2500], ["H1", 3600, 1500],
  ["H4", 14400, 1500], ["D1", 86400, 1500]
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let nextId = 0;
    const pending = new Map();
    const timeout = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("WebSocket connection timed out")); }, 20000);
    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      ws.addEventListener("message", event => {
        let data;
        try { data = JSON.parse(String(event.data)); } catch { return; }
        const entry = pending.get(data.req_id);
        if (!entry) return;
        pending.delete(data.req_id); clearTimeout(entry.timer);
        if (data.error) entry.reject(new Error(data.error.message || "Deriv API error"));
        else entry.resolve(data);
      });
      ws.addEventListener("close", () => {
        for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(new Error("WebSocket closed")); pending.delete(id); }
      });
      resolve({
        ask(payload, timeoutMs = 30000) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            const timer = setTimeout(() => { pending.delete(id); rej(new Error("Request timed out: " + JSON.stringify(payload))); }, timeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ ...payload, req_id: id }));
          });
        },
        close() { try { ws.close(); } catch {} }
      });
    });
    ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WebSocket connection error")); }, { once: true });
  });
}
const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
function resolveSymbol(symbols, id, name) {
  const found = symbols.find(s => norm(s.underlying_symbol_name || s.display_name) === norm(name)) ||
    symbols.find(s => (s.underlying_symbol || s.symbol) === id);
  return found && (found.underlying_symbol || found.symbol);
}
function normalizeCandles(raw, seconds, now) {
  return (raw || []).map(c => ({ epoch: Number(c.epoch), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
    .filter(c => [c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite) &&
      c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && c.high >= c.low &&
      c.epoch + seconds <= now).sort((a, b) => a.epoch - b.epoch);
}
async function fetchCandleHistory(client, symbol, granularity, requestedCount, now, pageSize = 1000) {
  const byEpoch = new Map();
  let end = "latest";
  let previousOldest = Infinity;
  while (byEpoch.size < requestedCount) {
    const count = Math.min(pageSize, requestedCount - byEpoch.size);
    const reply = await client.ask({ ticks_history: symbol, adjust_start_time: 1, count,
      end, granularity, style: "candles" });
    const page = normalizeCandles(reply.candles, granularity, now);
    if (!page.length) break;
    const oldest = page[0].epoch;
    if (!(oldest < previousOldest)) break;
    for (const candle of page) byEpoch.set(candle.epoch, candle);
    previousOldest = oldest;
    end = String(oldest - 1);
    await sleep(100);
  }
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch).slice(-requestedCount);
}
async function main() {
  const client = await connect();
  const output = { version: 1, generatedAt: null, generatedEpoch: null, mode: "historical_research_only",
    requestedFrames: FRAMES.map(([timeframe, granularity, count]) => ({ timeframe, granularity, count })),
    markets: {}, errors: [] };
  try {
    const time = await client.ask({ time: 1 });
    const now = Number(time.time) || Math.floor(Date.now() / 1000);
    output.generatedEpoch = now; output.generatedAt = new Date(now * 1000).toISOString();
    let reply = await client.ask({ active_symbols: "brief" });
    let symbols = reply.active_symbols || [];
    if (MARKETS.some(([id, name]) => !resolveSymbol(symbols, id, name))) {
      reply = await client.ask({ active_symbols: "full" });
      symbols = [...symbols, ...(reply.active_symbols || [])];
    }
    for (const [marketId, marketName] of MARKETS) {
      const symbol = resolveSymbol(symbols, marketId, marketName);
      if (!symbol) { output.errors.push({ marketId, message: "Symbol could not be resolved." }); continue; }
      const market = { marketId, marketName, symbol, timeframes: {}, errors: [] };
      for (const [timeframe, granularity, count] of FRAMES) {
        try {
          const candles = await fetchCandleHistory(client, symbol, granularity, count, now);
          market.timeframes[timeframe] = candles;
          if (candles.length < 60) market.errors.push({ timeframe, message: "Fewer than 60 completed candles returned." });
          console.log(JSON.stringify({ event: "backfill_frame", marketId, timeframe, count: candles.length,
            firstEpoch: candles[0]?.epoch ?? null, lastEpoch: candles.at(-1)?.epoch ?? null }));
        } catch (error) {
          market.timeframes[timeframe] = [];
          market.errors.push({ timeframe, message: error.message });
        }
        await sleep(150);
      }
      output.markets[marketId] = market;
      if (market.errors.length) output.errors.push(...market.errors.map(e => ({ marketId, ...e })));
    }
    fs.writeFileSync("top_down_swing_snapshot.json", JSON.stringify(output));
    const total = Object.values(output.markets).reduce((sum, m) =>
      sum + Object.values(m.timeframes).reduce((n, c) => n + c.length, 0), 0);
    console.log(JSON.stringify({ event: "backfill_complete", generatedAt: output.generatedAt,
      markets: Object.keys(output.markets).length, candles: total, errors: output.errors.length }));
    if (Object.keys(output.markets).length !== MARKETS.length || output.errors.length)
      process.exitCode = 1;
  } finally { client.close(); }
}
if (require.main === module)
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { fetchCandleHistory, normalizeCandles };
