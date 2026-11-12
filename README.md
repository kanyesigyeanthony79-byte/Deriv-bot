# Deriv Signal Assistant: bot setup

Needs Node 22+ and an always-on machine (VPS, Raspberry Pi or a worker on a host such as Render or Railway). A phone browser tab cannot run it in the background.

1. `cp .env.example .env` and fill it in. `.env` is git-ignored and must never go in `public/`.
2. **Signal-only first** (default): `node bot.js`. It scans the five markets, logs to `bot.log`, and sends Telegram alerts if `TELEGRAM_*` is set. No orders are possible in this mode.
3. **Demo trading:** create a Deriv token with the `trade` scope (see developers.deriv.com/llms/authentication.md), set `DERIV_TOKEN`, `DERIV_ACCOUNT_ID` (your DEMO account id, and `DERIV_APP_ID` if it is a PAT), then `TRADE_ENABLED=true`, `TRADE_MODE=demo`. The bot fetches a one-time WebSocket URL per trade and refuses to trade if that URL is not a demo endpoint.
4. **Kill switch:** create a file named `STOP` next to `bot.js` (`touch STOP`). No new trade is placed while it exists. Delete it to resume.

## What it does and does not do
- Same signal rules as the app (`engine.js` is a port of the app's `evaluate`), same cooldown, one signal per candle.
- Buys a fixed-stake Rise/Fall (`CALL` for BUY, `PUT` for SELL) for `TRADE_DURATION_CANDLES` x 15 minutes, only if the signal is under 2 minutes old and the quoted payout ratio is at least `MIN_PAYOUT_RATIO`.
- Limits: `MAX_TRADES_PER_DAY`, `MAX_OPEN_TRADES`, one open trade per market, `MAX_DAILY_LOSS` (from account balance), `STAKE` capped at 20.
- No martingale, no stake increase after losses, no loss recovery. Nothing reads results to change stake.
- Real money needs `TRADE_MODE=real`, `I_ACCEPT_REAL_MONEY_RISK=yes` and an explicit `MAX_DAILY_LOSS`.

## Read before enabling real money
Nothing here shows this strategy is profitable. At an 80% payout a fixed-duration trade must win about 56% of the time just to break even. Run the backtest, then run demo for weeks and judge 100+ trades before considering real money. Not financial advice.
