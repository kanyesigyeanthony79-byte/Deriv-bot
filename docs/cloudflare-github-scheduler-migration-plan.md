# Cloudflare-to-GitHub scheduler migration — pilot plan

## Current production arrangement

- Cloudflare Worker `deriv-mtf-watchdog` runs every minute.
- It dispatches the Multi-Timeframe Data Collector at minute offset 1 and the Deriv Market Monitor at minute offset 4 of each five-minute cycle.
- The production workflows currently have `workflow_dispatch` and push triggers, but no native GitHub schedule.
- The research candle collector and daily report already use GitHub-native schedules.

## Pilot added in this branch

`.github/workflows/github-scheduler-pilot.yml` runs at the same two five-minute offsets. It records only GitHub's schedule event and uploads a small artifact. It does not call Deriv, Telegram, Cloudflare KV, or MT5, and does not modify production files.

The workflow is intentionally on a non-default branch in this draft PR. GitHub scheduled workflows run from the default branch, so the pilot will not begin until this PR is merged.

## Pilot acceptance criteria

Collect at least 24 hours of evidence, preferably 48 hours:

1. Only runs with event `schedule` count as scheduler evidence; manual runs are excluded.
2. Confirm both cron expressions appear in the run metadata.
3. Measure expected versus observed runs, start-time delay, gaps, queued runs, and failures.
4. Confirm each run uploads its evidence artifact.
5. Do not infer reliability from a handful of successful runs.

A 5-minute GitHub schedule is supported, but GitHub warns scheduled runs can be delayed during high load and may be dropped. Therefore, the pilot must demonstrate acceptable cadence before production cutover.

## Production cutover — separate approval required

After the pilot passes and the user approves:

1. Add the two native cron expressions to the production collector and scanner workflows.
2. Update the scanner cadence audit to count native `schedule` events, not `[cloudflare_scheduler]` workflow-dispatch labels.
3. Review watchdog recovery rules so recovery dispatches cannot be mistaken for schedule evidence or create duplicate scanner runs.
4. Enable the native schedules and verify both workflows run successfully on schedule.
5. Only after verification, disable the Cloudflare dispatch scheduler. Preserve its source, bindings and deployment metadata for rollback.

## Guardrails

- This draft does not change the live Cloudflare Worker, its cron, secrets, bindings, or KV.
- It does not change scanner strategy, signal rules, Telegram alert settings, or MT5 execution.
- Do not merge the production cutover in the same change as the pilot.
- Keep Cloudflare as rollback until native GitHub scheduling has been demonstrated.
- If cadence is unreliable, retain Cloudflare dispatch and use GitHub only for workloads already scheduled natively.
