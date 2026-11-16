"use strict";
const EXPECTED_MT5_DEMO_LOGIN = "32478970";
function validateMt5DemoAccount(account, expectedLogin = EXPECTED_MT5_DEMO_LOGIN) {
  if (!account || typeof account !== "object") throw new Error("mt5_account_missing");
  const login = String(account.login || "").trim();
  if (login !== String(expectedLogin)) throw new Error("mt5_account_identity_mismatch");
  const type = String(account.account_type || "").toLowerCase();
  const group = String(account.group || "").toLowerCase();
  if (!(type.includes("demo") || group.includes("demo"))) throw new Error("mt5_account_is_not_demo");
  const balance = Number(account.balance);
  if (!Number.isFinite(balance) || balance < 0) throw new Error("mt5_balance_invalid");
  return { accountId: login, accountType: type || "demo", group: String(account.group || ""), currency: String(account.currency || ""), balance };
}
function createLegacyReadOnlyClient(url, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url), pending = new Map();
    let nextId = 0, opened = false;
    const connectTimer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("mt5_websocket_connect_timeout")); }, timeoutMs);
    const failAll = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
    ws.addEventListener("open", () => {
      opened = true; clearTimeout(connectTimer);
      resolve({
        ask(payload, requestTimeoutMs = timeoutMs) {
          const keys = Object.keys(payload || {});
          const allowed = (payload.authorize && keys.length === 1) || (payload.mt5_login_list === 1 && keys.length === 1) ||
            (payload.mt5_get_settings === 1 && typeof payload.login === "string" && keys.every(k => ["mt5_get_settings", "login", "req_id"].includes(k)));
          if (!allowed) return Promise.reject(new Error("mt5_read_only_request_not_allowed"));
          if (ws.readyState !== 1) return Promise.reject(new Error("mt5_websocket_not_open"));
          const reqId = ++nextId;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => { pending.delete(reqId); rej(new Error("mt5_read_only_request_timeout")); }, requestTimeoutMs);
            pending.set(reqId, { resolve: res, reject: rej, timer });
            try { ws.send(JSON.stringify({ ...payload, req_id: reqId })); }
            catch { clearTimeout(timer); pending.delete(reqId); rej(new Error("mt5_read_only_request_send_failed")); }
          });
        },
        close() { failAll(new Error("mt5_websocket_closed")); try { ws.close(); } catch {} }
      });
    });
    ws.addEventListener("message", event => {
      let data; try { data = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); } catch { return; }
      const item = data && pending.get(Number(data.req_id)); if (!item) return;
      pending.delete(Number(data.req_id)); clearTimeout(item.timer); item.resolve(data);
    });
    ws.addEventListener("error", () => { if (!opened) { clearTimeout(connectTimer); reject(new Error("mt5_websocket_connection_failed")); } failAll(new Error("mt5_websocket_transport_error")); });
    ws.addEventListener("close", () => { if (!opened) { clearTimeout(connectTimer); reject(new Error("mt5_websocket_closed_before_open")); } failAll(new Error("mt5_websocket_closed")); });
  });
}
async function createMt5DemoReadOnlySnapshot({ token, appId, accountId = EXPECTED_MT5_DEMO_LOGIN, WebSocketImpl = globalThis.WebSocket, now = () => Date.now(), timeoutMs = 15000 }) {
  if (!token || !appId) throw new Error("mt5_read_token_and_app_id_required");
  if (String(accountId) !== EXPECTED_MT5_DEMO_LOGIN) throw new Error("unexpected_mt5_demo_account_configured");
  const client = await createLegacyReadOnlyClient("wss://ws.derivws.com/websockets/v3?app_id=" + encodeURIComponent(String(appId)), { WebSocketImpl, timeoutMs });
  try {
    const auth = await client.ask({ authorize: token });
    if (auth.error || !auth.authorize) throw new Error("mt5_read_only_authorization_failed");
    const list = await client.ask({ mt5_login_list: 1 });
    if (list.error || !Array.isArray(list.mt5_login_list)) throw new Error("mt5_account_list_unavailable");
    const listed = list.mt5_login_list.find(item => String(item && item.login || "").trim() === EXPECTED_MT5_DEMO_LOGIN);
    const verified = validateMt5DemoAccount(listed);
    const settingsResponse = await client.ask({ mt5_get_settings: 1, login: EXPECTED_MT5_DEMO_LOGIN });
    if (settingsResponse.error || !settingsResponse.mt5_get_settings) throw new Error("mt5_account_settings_unavailable");
    const settings = settingsResponse.mt5_get_settings;
    if (settings.login && String(settings.login) !== EXPECTED_MT5_DEMO_LOGIN) throw new Error("mt5_account_settings_identity_mismatch");
    const balance = Number(settings.balance ?? verified.balance);
    if (!Number.isFinite(balance) || balance < 0) throw new Error("mt5_balance_invalid");
    return { mode: "demo", product: "MT5 CFDs", accountId: EXPECTED_MT5_DEMO_LOGIN, accountType: verified.accountType,
      group: verified.group, currency: String(settings.currency || verified.currency || ""), balance,
      equityEstimate: null, openPositions: null, fetchedAt: new Date(now()).toISOString(),
      requestTypes: ["authorize", "mt5_login_list", "mt5_get_settings"], ordersPlaced: 0 };
  } finally { client.close(); }
}
module.exports = { EXPECTED_MT5_DEMO_LOGIN, validateMt5DemoAccount, createLegacyReadOnlyClient, createMt5DemoReadOnlySnapshot };
