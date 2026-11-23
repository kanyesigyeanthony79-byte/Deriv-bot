const REPO = "kanyesigyeanthony79-byte/Deriv-bot";
const BRANCH = "main";
const LEGACY_WORKFLOWS = [
  { id: 417087054, key: "market-monitor", name: "Deriv Market Monitor", minuteOffset: 4 }
];
const R10_WORKFLOW_PATH = ".github/workflows/volatility10-paper.yml";
const R10_PROVIDER_ID = "volatility10_ema_atr_slope20_v1";

function headers(env) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is missing");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "Deriv-Cloudflare-External-Scheduler",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}
async function github(env, path, init = {}) {
  const response = await fetch("https://api.github.com" + path, {
    ...init, headers: { ...headers(env), ...(init.headers || {}) }
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  if (response.status === 204) return null;
  return response.json();
}
async function getR10Workflow(env) {
  const data = await github(env, `/repos/${REPO}/actions/workflows?per_page=100`);
  const workflow = (data.workflows || []).find(item => item.path === R10_WORKFLOW_PATH);
  if (!workflow) throw new Error("Volatility 10 paper workflow was not found on the configured branch");
  return workflow;
}
async function inspectRuns(env, workflowId) {
  const data = await github(env, `/repos/${REPO}/actions/workflows/${workflowId}/runs?branch=${BRANCH}&per_page=20`);
  const runs = data.workflow_runs || [];
  return {
    activeRuns: runs.filter(run => run.status === "queued" || run.status === "in_progress")
      .map(run => ({ id: run.id, status: run.status, event: run.event, createdAt: run.created_at, url: run.html_url })),
    latestRun: runs[0] ? {
      id: runs[0].id, status: runs[0].status, conclusion: runs[0].conclusion,
      event: runs[0].event, createdAt: runs[0].created_at, updatedAt: runs[0].updated_at, url: runs[0].html_url
    } : null
  };
}
async function dispatchR10(env, now) {
  if (env.R10_PAPER_SCHEDULER_ENABLED !== "true") {
    return { status: "disabled", reason: "R10_PAPER_SCHEDULER_ENABLED is not true" };
  }
  if (env.R10_PAPER_PROVIDER_ENABLED !== "true" || env.R10_EMERGENCY_KILL_SWITCH !== "false") {
    return { status: "blocked_by_safety_flags", providerEnabled: env.R10_PAPER_PROVIDER_ENABLED === "true",
      emergencyKillSwitch: env.R10_EMERGENCY_KILL_SWITCH !== "false" };
  }
  const workflow = await getR10Workflow(env);
  const runs = await inspectRuns(env, workflow.id);
  if (runs.activeRuns.length) {
    return { status: "skipped_active_run", workflowId: workflow.id, activeRuns: runs.activeRuns };
  }
  const lockKey = "r10_paper_dispatch_lock";
  const lock = await env.STATE.get(lockKey);
  if (lock) {
    let priorLock = null;
    try { priorLock = JSON.parse(lock); } catch {}
    const lockAt = Date.parse(priorLock?.at || "");
    const logicalTtlSeconds = Number(priorLock?.ttlSeconds) || 55;
    const lockAgeSeconds = Number.isFinite(lockAt) ? (now.getTime() - lockAt) / 1000 : 0;
    if (lockAgeSeconds < logicalTtlSeconds) {
      return { status: "skipped_dispatch_lock", lock: priorLock, lockAgeSeconds };
    }
    // KV requires a minimum 60-second TTL. The logical 55-second lease lets
    // the next minute's cron tick clear an expired key even at the TTL boundary.
    await env.STATE.delete(lockKey);
  }
  const lockValue = { providerId: R10_PROVIDER_ID, at: now.toISOString(), ttlSeconds: 55 };
  await env.STATE.put(lockKey, JSON.stringify(lockValue), { expirationTtl: 60 });
  try {
    await github(env, `/repos/${REPO}/actions/workflows/${workflow.id}/dispatches`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: BRANCH, inputs: { trigger_source: "cloudflare_r10_scheduler", provider_enabled: "true", emergency_kill_switch: "false", telegram_enabled: "true" } })
    });
    return { status: "dispatch_accepted", workflowId: workflow.id, at: now.toISOString(),
      note: "GitHub runner startup is asynchronous; this is not a hard real-time M1 delivery guarantee." };
  } catch (error) {
    await env.STATE.delete(lockKey);
    throw error;
  }
}
async function dispatchLegacyDue(env, now) {
  if (env.EXTERNAL_SCHEDULER_ENABLED !== "true") return { status: "disabled" };
  const minute = now.getUTCMinutes();
  const due = LEGACY_WORKFLOWS.filter(workflow => minute % 5 === workflow.minuteOffset);
  if (!due.length) return { status: "not_due" };
  const lockKey = "external_dispatch_lock";
  const lock = await env.STATE.get(lockKey);
  if (lock) return { status: "skipped_dispatch_lock", lock: JSON.parse(lock) };
  const statuses = await Promise.all(LEGACY_WORKFLOWS.map(async workflow => ({
    workflow, ...(await inspectRuns(env, workflow.id))
  })));
  const active = statuses.flatMap(item => item.activeRuns.map(run => ({ workflow: item.workflow.name, ...run })));
  if (active.length) return { status: "skipped_active_run", activeRuns: active };
  const target = due[0];
  await env.STATE.put(lockKey, JSON.stringify({ workflow: target.name, at: now.toISOString() }), { expirationTtl: 120 });
  try {
    await github(env, `/repos/${REPO}/actions/workflows/${target.id}/dispatches`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { trigger_source: "cloudflare_scheduler" } })
    });
    return { status: "dispatch_accepted", workflow: target.name, at: now.toISOString() };
  } catch (error) {
    await env.STATE.delete(lockKey);
    throw error;
  }
}
async function status(env) {
  const r10 = await getR10Workflow(env);
  const [r10Runs, legacyRuns] = await Promise.all([
    inspectRuns(env, r10.id),
    Promise.all(LEGACY_WORKFLOWS.map(async workflow => ({ ...workflow, ...(await inspectRuns(env, workflow.id)) })))
  ]);
  const [r10Lock, legacyLock] = await Promise.all([
    env.STATE.get("r10_paper_dispatch_lock"), env.STATE.get("external_dispatch_lock")
  ]);
  return {
    checkedAt: new Date().toISOString(),
    r10: { providerId: R10_PROVIDER_ID, workflowId: r10.id, workflowPath: r10.path,
      activeRuns: r10Runs.activeRuns, latestRun: r10Runs.latestRun,
      dispatchLock: r10Lock ? JSON.parse(r10Lock) : null,
      schedulerEnabled: env.R10_PAPER_SCHEDULER_ENABLED === "true",
      providerEnabled: env.R10_PAPER_PROVIDER_ENABLED === "true",
      emergencyKillSwitch: env.R10_EMERGENCY_KILL_SWITCH !== "false" },
    legacy: { schedulerEnabled: env.EXTERNAL_SCHEDULER_ENABLED === "true",
      workflows: legacyRuns, dispatchLock: legacyLock ? JSON.parse(legacyLock) : null }
  };
}
export default {
  async scheduled(controller, env) {
    const now = new Date(controller.scheduledTime || Date.now());
    const tick = { at: now.toISOString(), cron: controller.cron || null, r10: null, legacy: null };
    try {
      tick.r10 = await dispatchR10(env, now);
      console.log("R10_PAPER_SCHEDULER_TICK", JSON.stringify({ cron: controller.cron, r10: tick.r10 }));
    } catch (error) {
      tick.r10 = { status: "error", reason: String(error) };
      console.error("R10_PAPER_SCHEDULER_ERROR", String(error));
    }
    try {
      tick.legacy = await dispatchLegacyDue(env, now);
      console.log("LEGACY_EXTERNAL_SCHEDULER_TICK", JSON.stringify({ cron: controller.cron, legacy: tick.legacy }));
    } catch (error) {
      tick.legacy = { status: "error", reason: String(error) };
      console.error("LEGACY_EXTERNAL_SCHEDULER_ERROR", String(error));
    }
    try {
      await env.STATE.put("scheduler_last_tick", JSON.stringify(tick), { expirationTtl: 86400 });
    } catch (error) {
      console.error("SCHEDULER_DIAGNOSTIC_PERSIST_ERROR", String(error));
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      try {
        return Response.json(await status(env), { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        return Response.json({ condition: "check_failed", detail: String(error) }, { status: 502 });
      }
    }
    return new Response("Not found", { status: 404 });
  }
};
