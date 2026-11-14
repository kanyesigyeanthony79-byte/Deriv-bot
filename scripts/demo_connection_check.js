"use strict";
// Read-only demo-account connection check. Never requests proposals or places orders.
// Requires Node 22+ (global WebSocket) and local .env values. Never logs credentials or OTP URLs.
const fs = require("node:fs");
const path = require("node:path");

try {
  fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^[\"']|[\"']$/g, "");
  });
} catch {}

const { DERIV_TOKEN: token, DERIV_ACCOUNT_ID: accountId, DERIV_APP_ID: appId } = process.env;
const fail = message => { console.error("DEMO CHECK FAILED: " + message); process.exitCode = 1; };
if (!token || !accountId) {
  fail("Add DERIV_TOKEN and the DEMO account's DERIV_ACCOUNT_ID to your local .env file.");
  process.exit();
}
if (typeof WebSocket === "undefined") {
  fail("This script needs Node.js 22 or newer with the built-in WebSocket API.");
  process.exit();
}

async function main() {
  const headers = { Authorization: "Bearer " + token };
  if (appId) headers["Deriv-App-ID"] = appId;
  const response = await fetch(
    "https://api.derivws.com/trading/v1/options/accounts/" + encodeURIComponent(accountId) + "/otp",
    { method: "POST", headers, signal: AbortSignal.timeout(15000) }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.data?.url) throw new Error("Could not obtain a WebSocket session (HTTP " + response.status + "). Check token scope, account ID and App ID.");
  const url = new URL(payload.data.url);
  if (url.protocol !== "wss:" || url.hostname !== "api.derivws.com" || !url.pathname.endsWith("/ws/demo")) {
    throw new Error("Deriv did not return a demo endpoint. Refusing to connect.");
  }

  const ws = new WebSocket(payload.data.url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("WebSocket connection timed out.")); }, 15000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket connection failed.")); };
  });

  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Demo balance response timed out.")), 15000);
      ws.onmessage = event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.error) { clearTimeout(timer); reject(new Error(message.error.message || "Demo account request failed.")); return; }
        if (message.msg_type === "balance" || message.balance) { clearTimeout(timer); resolve(message.balance || message); }
      };
      ws.send(JSON.stringify({ balance: 1, req_id: 1 }));
    });
    if (typeof result.balance !== "number" || !result.currency) throw new Error("Connected, but Deriv returned an unexpected balance response.");
    console.log("DEMO CONNECTION VERIFIED");
    console.log("Account: " + accountId);
    console.log("Balance: " + result.balance + " " + result.currency);
    console.log("Permissions used: authenticated demo session + read-only balance request.");
    console.log("No proposal, buy, sell, or other trading request was sent.");
  } finally {
    ws.close();
  }
}

main().catch(error => fail(error.message));
