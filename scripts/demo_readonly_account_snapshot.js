"use strict";

// Read-only authenticated DEMO account snapshot for shadow-mode commissioning.
// Allowed requests: balance, portfolio, and status for already-open contracts.
// This module intentionally has no proposal, buy, sell, or contract-update path.

const fs = require("node:fs");
const path = require("node:path");

const READ_ONLY_REQUESTS = new Set(["balance", "portfolio", "proposal_open_contract"]);

function parseEnvText(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (/^[A-Z_0-9]+$/.test(key)) values[key] = value;
  }
  return values;
}

function isDemoOtpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "wss:" &&
      url.hostname === "api.derivws.com" &&
      url.pathname === "/trading/v1/options/ws/demo" &&
      Boolean(url.searchParams.get("otp"));
  } catch {
    return false;
  }
}

function validateReadOnlyRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("read_only_request_payload_invalid");
  }
  const keys = Object.keys(payload);
  if (keys.length === 1 && payload.balance === 1 && keys[0] === "balance") return true;
  if (keys.length === 1 && payload.portfolio === 1 && keys[0] === "portfolio") return true;
  if (keys.length === 2 && payload.proposal_open_contract === 1 &&
      keys.includes("proposal_open_contract") && keys.includes("contract_id") &&
      Number.isSafeInteger(Number(payload.contract_id)) && Number(payload.contract_id) > 0) return true;
  throw new Error("read_only_request_not_allowed");
}

function connectReadOnlyWebSocket(url, {
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = 15000
} = {}) {
  if (!isDemoOtpUrl(url)) throw new Error("demo_websocket_required");
  if (typeof WebSocketImpl !== "function") throw new Error("websocket_implementation_unavailable");

  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocketImpl(url); }
    catch { reject(new Error("demo_websocket_construction_failed")); return; }

    const pending = new Map();
    let nextId = 0;
    let settled = false;
    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error("demo_websocket_connect_timeout"));
    }, timeoutMs);

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
      clearTimeout(connectTimer);
      resolve({
        ask(payload, requestTimeoutMs = 15000) {
          try { validateReadOnlyRequest(payload); }
          catch (error) { return Promise.reject(error); }
          if (ws.readyState !== 1) return Promise.reject(new Error("demo_websocket_not_open"));
          const reqId = ++nextId;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(reqId);
              rej(new Error("demo_read_only_request_timeout"));
            }, requestTimeoutMs);
            pending.set(reqId, { resolve: res, reject: rej, timer });
            try { ws.send(JSON.stringify({ ...payload, req_id: reqId })); }
            catch {
              clearTimeout(timer);
              pending.delete(reqId);
              rej(new Error("demo_read_only_request_send_failed"));
            }
          });
        },
        close() {
          failPending(new Error("demo_websocket_closed"));
          try { ws.close(); } catch {}
        }
      });
    });

    ws.addEventListener("message", event => {
      let data;
      try { data = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); }
      catch { return; }
      const item = data && pending.get(Number(data.req_id));
      if (!item) return;
      pending.delete(Number(data.req_id));
      clearTimeout(item.timer);
      item.resolve(data);
    });

    ws.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        reject(new Error("demo_websocket_connection_failed"));
      }
      failPending(new Error("demo_websocket_transport_error"));
    });

    ws.addEventListener("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        reject(new Error("demo_websocket_closed_before_open"));
      }
      failPending(new Error("demo_websocket_closed"));
    });
  });
}

function unwrap(response, key) {
  if (!response || response.error) {
    throw new Error(key + "_request_failed");
  }
  if (!response[key]) throw new Error(key + "_response_missing");
  return response[key];
}

async function createDerivDemoReadOnlySnapshot({
  token,
  accountId,
  appId,
  fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now(),
  timeoutMs = 15000
}) {
  if (!token || !accountId) throw new Error("demo_token_and_account_id_required");
  const expectedAccountId = String(accountId).trim().toUpperCase();
  if (!/^DOT[0-9]+$/.test(expectedAccountId)) throw new Error("demo_account_id_must_be_a_DOT_id");
  if (typeof fetchImpl !== "function") throw new Error("fetch_implementation_required");

  const headers = { Authorization: "Bearer " + token, Accept: "application/json" };
  if (appId) headers["Deriv-App-ID"] = String(appId);
  const response = await fetchImpl(
    "https://api.derivws.com/trading/v1/options/accounts/" + encodeURIComponent(expectedAccountId) + "/otp",
    { method: "POST", headers, signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined }
  );
  const body = await response.json().catch(() => ({}));
  const websocketUrl = body && body.data && body.data.url;
  if (!response.ok || !isDemoOtpUrl(websocketUrl)) {
    throw new Error("demo_otp_request_failed_or_non_demo_url");
  }

  const client = await connectReadOnlyWebSocket(websocketUrl, { WebSocketImpl, timeoutMs });
  try {
    const [balanceResponse, portfolioResponse] = await Promise.all([
      client.ask({ balance: 1 }),
      client.ask({ portfolio: 1 })
    ]);
    const balance = unwrap(balanceResponse, "balance");
    const portfolio = unwrap(portfolioResponse, "portfolio");

    const returnedAccountId = String(balance.loginid || "").toUpperCase();
    if (returnedAccountId !== expectedAccountId) throw new Error("demo_account_identity_mismatch");
    const availableBalance = Number(balance.balance);
    if (!Number.isFinite(availableBalance) || availableBalance < 0) throw new Error("demo_balance_value_invalid");
    if (!Array.isArray(portfolio.contracts)) throw new Error("demo_portfolio_contracts_missing");

    const openPositions = [];
    for (const contract of portfolio.contracts) {
      const contractId = Number(contract.contract_id);
      if (!Number.isSafeInteger(contractId) || contractId <= 0) throw new Error("demo_portfolio_contract_id_invalid");
      const statusResponse = await client.ask({ proposal_open_contract: 1, contract_id: contractId });
      const status = unwrap(statusResponse, "proposal_open_contract");
      if (Number(status.contract_id) !== contractId) throw new Error("demo_open_contract_identity_mismatch");

      const buyPrice = Number(status.buy_price ?? contract.buy_price);
      const bidPriceValue = Number(status.bid_price ?? contract.bid_price);
      const profitValue = Number(status.profit ?? contract.profit);
      const openedAt = Number(status.date_start ?? contract.date_start);
      if (!Number.isFinite(buyPrice) || buyPrice < 0 || !Number.isFinite(openedAt)) {
        throw new Error("demo_open_contract_reconciliation_incomplete");
      }
      const currentValue = Number.isFinite(bidPriceValue)
        ? bidPriceValue
        : Number.isFinite(profitValue) ? Math.max(0, buyPrice + profitValue) : NaN;
      if (!Number.isFinite(currentValue)) throw new Error("demo_open_contract_value_unavailable");

      openPositions.push({
        contractId,
        symbol: status.underlying ?? contract.underlying ?? null,
        contractType: status.contract_type ?? contract.contract_type ?? null,
        buyPrice,
        currentValue,
        profit: Number.isFinite(profitValue) ? profitValue : currentValue - buyPrice,
        openedAt: openedAt * 1000,
        isValidToSell: status.is_valid_to_sell === 1 || status.is_valid_to_sell === true
      });
    }

    const equityEstimate = availableBalance + openPositions.reduce((sum, position) => sum + position.currentValue, 0);
    return {
      mode: "demo",
      accountId: expectedAccountId,
      currency: String(balance.currency || ""),
      balance: availableBalance,
      equityEstimate,
      openPositions,
      fetchedAt: new Date(now()).toISOString(),
      requestTypes: ["balance", "portfolio", ...(openPositions.length ? ["proposal_open_contract"] : [])]
    };
  } finally {
    client.close();
  }
}

async function main() {
  let env = process.env;
  try {
    const fileEnv = parseEnvText(fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8"));
    env = { ...fileEnv, ...process.env };
  } catch {}

  if (!env.DERIV_TOKEN || !env.DERIV_ACCOUNT_ID) {
    throw new Error("add_DERIV_TOKEN_and_demo_DERIV_ACCOUNT_ID_to_local_env");
  }
  const snapshot = await createDerivDemoReadOnlySnapshot({
    token: env.DERIV_TOKEN,
    accountId: env.DERIV_ACCOUNT_ID,
    appId: env.DERIV_APP_ID
  });
  console.log("DEMO READ-ONLY SNAPSHOT VERIFIED");
  console.log(JSON.stringify({
    mode: snapshot.mode,
    accountId: snapshot.accountId,
    balance: snapshot.balance,
    currency: snapshot.currency,
    equityEstimate: snapshot.equityEstimate,
    openContracts: snapshot.openPositions.length,
    positions: snapshot.openPositions,
    fetchedAt: snapshot.fetchedAt,
    requestTypes: snapshot.requestTypes,
    ordersPlaced: 0
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error("DEMO SNAPSHOT FAILED: " + error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  READ_ONLY_REQUESTS,
  parseEnvText,
  isDemoOtpUrl,
  validateReadOnlyRequest,
  connectReadOnlyWebSocket,
  createDerivDemoReadOnlySnapshot
};
