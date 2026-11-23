# Multi-timeframe retirement and R10 dashboard replacement

## Change summary

The multi-timeframe (MTF) collector and the scheduled research collector are retired. Their GitHub Actions jobs are hard-disabled with an explicit false job condition, so native schedules, push triggers, manual dispatches, and any already-configured external dispatch cannot run the collection jobs after this change is merged.

The Cloudflare watchdog source no longer dispatches the legacy Multi-Timeframe Data Collector. The separate Deriv Market Monitor schedule is retained. The R10 paper scanner workflow and its R10-specific dispatch path remain separate and are not disabled.

The dashboard's former MTF signals page is replaced with a Volatility 10 exclusive M1 paper view. It reads only:
- `volatility10_paper_journal.json`
- `volatility10_paper_state.json`

The dashboard validates the provider ID before rendering and reports missing/stale records as unavailable rather than interpreting them as no signals or healthy operation.

## R10 independence

The R10 scanner fetches its own completed M1 candles directly from Deriv's public WebSocket API. It does not read the MTF collector's candle archive. Its provider ID is `volatility10_ema_atr_slope20_v1`; the strategy is paper-only and never submits orders.

## Deployment checklist

1. Merge this change after the repository test workflows pass.
2. Deploy `cloudflare/deriv-mtf-watchdog.js` to the existing `deriv-mtf-watchdog` Worker, preserving its existing secrets, KV binding, and cron trigger. This removes the MTF workflow from its legacy dispatch list while retaining the separate R10 scheduler and market monitor.
3. If the older `deriv-mtf-watchdog-worker.js` is deployed anywhere, update it too; its MTF dispatch entry is also removed in this change.
4. Confirm the GitHub Actions Multi-Timeframe Data Collector and Research Candle Collector jobs are skipped/disabled after merge.
5. Confirm the R10 paper scanner is dispatched independently and that its paper journal/state files update. Keep the emergency kill switch and notification route fail-closed until an explicit operational check confirms safe paper-only behavior.
6. Do not enable MT5 execution or any live order route.

## Data retention

No existing MTF journals, historical performance reports, daily archive records, or research files are deleted. The dashboard change affects the visible MTF page only; it does not erase historical audit records.
