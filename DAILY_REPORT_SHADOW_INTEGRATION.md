# Read-only demo account snapshot in the daily report

## What is added

The hosted signal scanner now takes one authenticated DEMO account snapshot only when it is preparing the previous Uganda calendar day's daily report. It uses the same strict read-only module as the local commissioning check.

The Telegram report keeps the signal statistics separate from the point-in-time account snapshot. It reports the demo account ID, balance, estimated equity, number of currently open contracts, and snapshot timestamp. It explicitly says this is not daily profit/loss. No account transactions or historical balance changes are inferred.

If the demo credentials are absent, the daily signal report can still be delivered and labels the account snapshot as not connected. If the read-only snapshot fails, the report still goes out with the snapshot marked unavailable. A failed Telegram delivery is not marked delivered, so the scanner can retry on its next run.

## Required GitHub Actions secrets

In the repository, open **Settings → Secrets and variables → Actions → New repository secret** and add:

- `DERIV_TOKEN`: the private Deriv token used for the demo read-only snapshot
- `DERIV_ACCOUNT_ID`: the demo account ID beginning with `DOT` (currently `DOT91725732`)
- `DERIV_APP_ID`: the registered Deriv application ID, if required for the token type

Do not paste the token into chat, commit it, put it in a workflow file, or add it to a public issue. The workflow passes these values to the process as GitHub Actions secrets.

The account token has Trade permission selected. Treat it as sensitive. The snapshot module itself allows only balance, portfolio, and status requests for contracts already present in the portfolio. It has no proposal, buy, sell, or contract-update operation. The reporting workflow does not enable the trading bot; keep `TRADE_ENABLED=false`.

## Validation boundaries

Automated tests use mocked Deriv and Telegram responses. They verify report composition, snapshot formatting, and the delivery handoff/retry contract without contacting Deriv or sending a real Telegram message.

A successful GitHub Actions test run does not prove the live Telegram delivery path. After the secrets are configured and this PR is reviewed, a separate controlled delivery check is still required. No automatic orders are part of that check.

The account snapshot is taken at report-generation time (after the reporting window), not at the prior day's start and end. It is therefore a current account-state reference, not a daily trading P/L calculation.
