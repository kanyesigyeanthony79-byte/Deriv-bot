const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const ws = new WebSocket(WS_URL);
const pending = new Map();
let nextId = 10;
let active = [];
const wanted = [
  { label: "VolSwitch Low", test: s => /vol.?switch.*low/i.test(s.name + " " + s.code) },
  { label: "VolSwitch Medium", test: s => /vol.?switch.*medium/i.test(s.name + " " + s.code) },
  { label: "VolSwitch High", test: s => /vol.?switch.*high/i.test(s.name + " " + s.code) },
  { label: "XAUUSD / Gold", test: s => /xau.?usd|gold\s*\/\s*usd|gold\s*usd/i.test(s.name + " " + s.code) },
  { label: "Crash 500", test: s => /crash\s*500/i.test(s.name + " " + s.code) },
  { label: "Boom 500", test: s => /boom\s*500/i.test(s.name + " " + s.code) }
];

function request(payload, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timed out waiting for request " + id));
    }, 18000);
    pending.set(id, data => {
      clearTimeout(timer);
      if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
      else resolve(data);
    });
    ws.send(JSON.stringify({ ...payload, req_id: id }));
  });
}

ws.addEventListener("open", async () => {
  try {
    const response = await request({ active_symbols: "full" }, 1);
    active = (response.active_symbols || []).map(s => ({
      code: s.underlying_symbol || s.symbol || "",
      name: s.underlying_symbol_name || s.display_name || "",
      type: s.underlying_symbol_type || s.symbol_type || "",
      market: s.market || "",
      submarket: s.submarket || ""
    }));
    const selected = wanted.map(w => {
      const matches = active.filter(w.test);
      return { label: w.label, matches };
    });
    const found = selected.flatMap(x => x.matches);
    const unique = [...new Map(found.map(x => [x.code, x])).values()];
    const checks = await Promise.all(unique.map(async s => {
      const id = nextId++;
      try {
        const h = await request({
          ticks_history: s.code,
          count: 200,
          end: "latest",
          style: "candles",
          granularity: 900
        }, id);
        const candles = h.candles || [];
        return { code: s.code, name: s.name, type: s.type, m15_available: candles.length > 0, candle_count: candles.length, latest_candle_epoch: candles.at(-1)?.epoch ?? null };
      } catch (e) {
        return { code: s.code, name: s.name, type: s.type, m15_available: false, error: e.message };
      }
    }));
    const output = selected.map(x => ({
      requested: x.label,
      found: x.matches.length > 0,
      symbols: x.matches.map(m => {
        const check = checks.find(c => c.code === m.code);
        return { ...m, m15: check || null };
      })
    }));
    console.log("DERIV_MARKET_DISCOVERY_RESULT");
    console.log(JSON.stringify({ checked_at: new Date().toISOString(), timeframe: "M15", results: output }, null, 2));
    ws.close();
  } catch (e) {
    console.error("Discovery failed:", e.message);
    ws.close();
    process.exitCode = 1;
  }
});

ws.addEventListener("message", event => {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  const id = data.req_id;
  if (pending.has(id)) pending.get(id)(data);
});
ws.addEventListener("error", () => {
  console.error("WebSocket connection error");
  process.exitCode = 1;
});
setTimeout(() => {
  if (ws.readyState !== WebSocket.CLOSED) {
    console.error("Discovery overall timeout");
    ws.close();
    process.exitCode = 1;
  }
}, 60000).unref();
