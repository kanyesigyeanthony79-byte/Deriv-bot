"use strict";

const { isDemoUrl } = require("./deriv_demo_adapter");

function timeoutSignal(ms) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms) : undefined;
}

async function requestDemoOtp({ token, accountId, appId, fetchImpl = fetch, timeoutMs = 15000 }) {
  if (!token || !accountId) throw new Error("demo_token_and_account_id_required");
  if (typeof fetchImpl !== "function") throw new Error("fetch_implementation_required");
  const headers = { Authorization: "Bearer " + token, Accept: "application/json" };
  if (appId) headers["Deriv-App-ID"] = String(appId);
  const response = await fetchImpl(
    "https://api.derivws.com/trading/v1/options/accounts/" + encodeURIComponent(accountId) + "/otp",
    { method: "POST", headers, signal: timeoutSignal(timeoutMs) }
  );
  const body = await response.json().catch(() => ({}));
  const url = body && body.data && body.data.url;
  if (!response.ok || !isDemoUrl(url)) {
    throw new Error("demo_otp_request_failed_or_non_demo_url");
  }
  return url;
}

function connectWebSocket(url, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 15000 } = {}) {
  if (!isDemoUrl(url)) throw new Error("demo_websocket_required");
  if (typeof WebSocketImpl !== "function") throw new Error("websocket_implementation_unavailable");

  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocketImpl(url); }
    catch (_) { reject(new Error("demo_websocket_construction_failed")); return; }
    const pending = new Map();
    let nextId = 0;
    let settled = false;
    const connectTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch (_) {}
        reject(new Error("demo_websocket_connect_timeout"));
      }
    }, timeoutMs);

    const cleanup = () => clearTimeout(connectTimer);
    const failPending = error => {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(error);
      }
      pending.clear();
    };

    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        ask(payload, requestTimeoutMs = 20000) {
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return Promise.reject(new Error("deriv_request_payload_must_be_object"));
          }
          if (ws.readyState !== 1) return Promise.reject(new Error("demo_websocket_not_open"));
          const reqId = ++nextId;
          const message = { ...payload, req_id: reqId };
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(reqId);
              rej(new Error("deriv_request_timeout"));
            }, requestTimeoutMs);
            pending.set(reqId, { resolve: res, reject: rej, timer });
            try { ws.send(JSON.stringify(message)); }
            catch (_) {
              clearTimeout(timer);
              pending.delete(reqId);
              rej(new Error("deriv_request_send_failed"));
            }
          });
        },
        close() {
          failPending(new Error("demo_websocket_closed"));
          try { ws.close(); } catch (_) {}
        }
      });
    });

    ws.addEventListener("message", event => {
      let data;
      try { data = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); }
      catch (_) { return; }
      const item = data && pending.get(Number(data.req_id));
      if (!item) return;
      pending.delete(Number(data.req_id));
      clearTimeout(item.timer);
      item.resolve(data);
    });

    ws.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error("demo_websocket_connection_failed"));
      }
      failPending(new Error("demo_websocket_transport_error"));
    });

    ws.addEventListener("close", () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error("demo_websocket_closed_before_open"));
      }
      failPending(new Error("demo_websocket_closed"));
    });
  });
}

async function createDerivDemoConnection(options = {}) {
  const url = await requestDemoOtp(options);
  const connection = await connectWebSocket(url, options);
  return { connection, websocketUrl: url };
}

module.exports = { requestDemoOtp, connectWebSocket, createDerivDemoConnection };
