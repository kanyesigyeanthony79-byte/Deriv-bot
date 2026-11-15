# Deriv Signal Assistant: bot setup

Needs Node 22+ and an always-on machine (VPS, Raspberry Pi or a worker on a host such as Render or Railway). A phone browser tab cannot run it in the background.

1. Copy `.env.example` to `.env` and fill in credentials locally. The `.env` file is git-ignored and must never go in `public/`.
2. **Read-only demo connection check (recommended first):** set `DERIV_TOKEN`, the DEMO account's `DERIV_ACCOUNT_ID`, and `DERIV_APP_ID` if using a PAT. Run `node scripts/demo_connection_check.js`. This obtains a short-lived demo WebSocket session and reads the demo balance only. It never requests a proposal or places an order.
3. **Signal-only scanner:** `node bot.js` with `TRADE_ENABLED=false` (default). It scans the five configured markets and sends Telegram alerts if configured. No orders are placed.
4. **Demo order testing is a separate, explicit step:** the existing bot can place fixed-stake Rise/Fall demo orders only if `TRADE_ENABLED=true` and `TRADE_MODE=demo`. Do not enable this until the strategy has passed replay and you have reviewed the stake, duration, and daily limits. The bot checks that Deriv returns a demo WebSocket endpoint before placing an order.
5. **Kill switch:** create a file named `STOP` next to `bot.js`. No new trade is placed while it exists.

## What it does and does not do
- The current production scanner uses the existing EMA/RSI/ATR rules in `engine.js`; this branch does not change its signals or Telegram path.
- The market-structure document in `research/market-structure-experiment.md` is a research specification only. BOS/CHoCH, multi-timeframe confirmation, and trade-management rules have not yet been implemented or validated.
- The existing demo-order mode buys a fixed-stake Rise/Fall contract for `TRADE_DURATION_CANDLES` x 15 minutes, subject to its age, payout, and risk-limit checks.
- No martingale, stake increase after losses, or loss recovery.
- Real-money mode is not part of this setup and must not be enabled.

## Validation warning
Nothing in the current research proves this strategy is profitable. The read-only demo connection check confirms only that the selected demo account can be authenticated and its balance read. It is not strategy validation or permission to activate automatic trading.
