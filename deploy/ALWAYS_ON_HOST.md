# Always-on scanner host (staged migration)

## Goal and safety boundaries

Run the existing `hosted_scanner.js` signal-only scanner on an always-on Linux host under systemd. The supervisor starts one scan immediately, then aligns subsequent scans to UTC five-minute boundaries. It waits for each scan to finish before starting another, so it does not overlap scans.

This deployment does **not** change signal-generation rules, entry/exit levels, alert age, cooldowns, Telegram routing, or trade execution. The scanner remains signal-only. Do not enable any order-execution mode.

## Important: this is a staged deployment

Do not disable the GitHub Actions scanner until the host has passed the acceptance checks below. Running both scanners against the same state files can create duplicate alerts or conflicting journal updates. Before cutover, arrange a single active scanner and migrate the latest state files safely.

## Host requirements

- Ubuntu 22.04+ (or another systemd Linux distribution)
- Node.js 22+
- Persistent disk; do not use an ephemeral container filesystem
- Outbound HTTPS and WebSocket access to Deriv and the configured Telegram Worker
- A dedicated unprivileged Linux account named `derivscanner`

## Files and secrets

The service expects the repository at `/opt/deriv-bot`. Keep runtime state on a dedicated persistent data volume, separate from the Git checkout. The service sets `SCANNER_DATA_DIR=/var/lib/deriv-scanner`; both the main scanner and multi-timeframe collector resolve all mutable journals/reports through this directory. The default remains the application directory when `SCANNER_DATA_DIR` is unset, preserving existing GitHub Actions behavior.

The data directory includes (among other runtime artifacts):
- `signal_state.json`, `trade_journal.json`, `scanner_heartbeat.json`
- `multi_timeframe_journal.json`, `multi_timeframe_data.json`, `multi_timeframe_dashboard.json`
- signal review, strategy-version, strategy-comparison, strategy-research, and shadow journals/reports.

Do not commit these mutable runtime files to the deployment checkout. Back up and migrate the full data directory, preserving file names and permissions.

Create `/etc/deriv-scanner.env` with restrictive permissions (0600), owned by root. Populate it using the existing GitHub Actions secret values; never commit credentials:

```ini
TELEGRAM_WORKER_URL=https://YOUR-TELEGRAM-WORKER.example
SIGNAL_API_KEY=REPLACE_WITH_SECRET
DERIV_TOKEN=REPLACE_WITH_READ_ONLY_OR_APPROVED_TOKEN
DERIV_ACCOUNT_ID=YOUR_ACCOUNT_ID
DERIV_APP_ID=YOUR_APP_ID
```

Do not paste credentials into chat, source code, issue comments, or logs. The scanner only reads the optional account snapshot; it must not place orders.

## Install

1. Install Node.js 22 and `flock` (provided by the `util-linux` package). Create the `derivscanner` service account and persistent directory `/var/lib/deriv-scanner`; ensure it is owned by `derivscanner:derivscanner` with restrictive permissions.
2. Deploy the repository to `/opt/deriv-bot` from the reviewed release/commit.
3. Install dependencies only if the project later adds production dependencies; the current scanner uses Node built-ins and repository modules.
4. Copy this service file to `/etc/systemd/system/deriv-scanner.service`.
5. Create and secure `/etc/deriv-scanner.env`.
6. Ensure `/var/lib/deriv-scanner` is mounted on persistent storage and owned by `derivscanner:derivscanner`; migrate the complete latest runtime data set into it before cutover.
7. Run `sudo systemctl daemon-reload`, then `sudo systemctl enable --now deriv-scanner`.

Useful checks:

```sh
sudo systemctl status deriv-scanner
sudo journalctl -u deriv-scanner -f
cat /var/lib/deriv-scanner/scanner_heartbeat.json
```

## Acceptance checks before cutover

- Service remains active and automatically restarts after a process or host restart.
- Heartbeat timestamps advance at five-minute intervals over at least 20 consecutive cycles.
- Every cycle reports market attempts/results; investigate partial or failed scans.
- Telegram delivery counters and logs agree with the worker's delivery records.
- Active-signal state and journal survive a service restart.
- Confirm only one scanner instance is active before enabling Telegram delivery on the host. The systemd unit uses `flock` on `/run/deriv-scanner/scanner.lock` to prevent a second service process from starting a competing supervisor.
- Confirm no order execution path is enabled.

## Cutover and rollback

1. Back up `signal_state.json`, `trade_journal.json`, and `scanner_heartbeat.json`.
2. Stop the GitHub Actions scanner workflow before enabling the host's Telegram-producing service. Keep the workflow definition available for rollback.
3. Start the host service and validate one scan with Telegram delivery disabled or otherwise safely isolated.
4. Enable the host as the sole production scanner only after state integrity and the acceptance checks are verified.
5. Roll back by stopping the host service first, then restoring the GitHub Actions scanner. Never run both alert-producing scanners concurrently against the same account/state.

## Current status

This is deployment preparation only. No host has been provisioned, no secrets have been copied, and no production cutover has occurred. A host address/SSH access and an approved persistent hosting environment are still required to deploy it.
