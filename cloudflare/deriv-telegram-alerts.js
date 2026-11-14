export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key"
    };
    const reply = (body, status = 200) => Response.json(body, { status, headers: cors });
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return reply({ error: "Use POST to submit an alert" }, 405);
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.SIGNAL_API_KEY) {
      return reply({ error: "Worker secrets are not configured" }, 500);
    }
    if (request.headers.get("X-API-Key") !== env.SIGNAL_API_KEY) return reply({ error: "Unauthorized" }, 401);

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
            EXPIRED: {
              title: "⏳ SIGNAL MONITORING EXPIRED",
              description: "The monitoring window ended without a confirmed take-profit or stop-loss outcome."
            },
            SL_HIT: {
              title: "❌ STOP LOSS HIT",
              description: "Price reached the stop-loss level."
            }
          };
          const outcome = outcomes[data.outcome];
          if (!outcome) return reply({ error: "Invalid outcome type" }, 400);
          if (!data.signalId) return reply({ error: "Missing signalId" }, 400);
          message = [
            outcome.title,
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
          message = [
            "🆕 NEW SIGNAL ALERT",
            "━━━━━━━━━━━━━━━━",
            `📊 Market: ${market}`,
            `📈 Direction: ${direction}`,
            `🎯 Entry: ${data.entry}`,
            `🛑 Stop Loss: ${data.stopLoss}`,
            `💰 Take Profit 1: ${data.tp1}`,
            `💰 Take Profit 2: ${data.tp2}`,
            data.signalId ? `🔖 Signal: ${String(data.signalId).slice(0, 60)}` : null,
            "━━━━━━━━━━━━━━━━",
            "⚠️ Signal only. Verify conditions before trading; no trade is executed automatically."
          ].filter(Boolean).join("\n");
        }
      }

      const telegramURL = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const telegramResponse = await fetch(telegramURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify((() => { const payload = { chat_id: env.TELEGRAM_CHAT_ID, text: message }; if (data.event === "new_signal" && env.REVIEW_PAGE_URL && data.signalId) { payload.reply_markup = { inline_keyboard: [[{ text: "REVIEW SIGNAL", url: env.REVIEW_PAGE_URL + "?signalId=" + encodeURIComponent(String(data.signalId)) }]] }; } return payload; })())
      });
      const result = await telegramResponse.json();
      if (!telegramResponse.ok || !result.ok) return reply({ error: "Telegram delivery failed" }, 502);
      return reply({ success: true, message: "Telegram alert delivered" });
    } catch (error) {
      return reply({ error: "Invalid request or delivery error" }, 400);
    }
  }
};
