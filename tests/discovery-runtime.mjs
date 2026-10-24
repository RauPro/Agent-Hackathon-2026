// Run after `npm run build`. Uses actual next dev/next start, temporary SQLite,
// fake keys and loopback providers. Outputs only synthetic, non-secret evidence.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { request as httpRequest } from "node:http";
import Database from "better-sqlite3";

const folder = mkdtempSync(join(tmpdir(), "sidekick-after-"));
const children = new Set();
const exa = "http://127.0.0.1:3143",
  openai = "http://127.0.0.1:3141/v1";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = {
  checkedAt: new Date().toISOString(),
  network:
    "All application provider fetches restricted to HTTP loopback by test preload; fake credentials only.",
  modes: [],
};
function launch(args, env, name) {
  const fd = openSync(join(folder, `${name}.log`), "a");
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
async function stop(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (signal === "SIGKILL") process.kill(-child.pid, signal);
  else child.kill(signal);
  const timeout = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 15000);
  await exited;
  clearTimeout(timeout);
}
async function waitFor(check, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await delay(100);
  }
  throw new Error("Runtime fixture check timed out");
}
async function setScenario(delayMs) {
  await fetch(`${exa}/scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario: "ready", delayMs }),
  });
}
function dbRow(path) {
  const db = new Database(path);
  const row = db
    .prepare("SELECT * FROM event_discoveries ORDER BY started_at DESC LIMIT 1")
    .get();
  db.close();
  return row;
}
async function verify(mode) {
  const port = mode === "dev" ? 3140 : 3150,
    origin = `http://127.0.0.1:${port}`;
  const path = join(folder, `${mode}.sqlite`);
  const env = {
    NODE_ENV: mode === "dev" ? "development" : "production",
    NEXT_TELEMETRY_DISABLED: "1",
    DATABASE_PATH: path,
    OPENAI_API_KEY: "test-key-not-a-secret",
    OPENAI_BASE_URL: openai,
    EXA_API_KEY: "test-exa-not-a-secret",
    EXA_TEST_BASE_URL: mode === "dev" ? exa : "",
    EXA_PRODUCTION_FIXTURE_URL: mode === "start" ? exa : "",
    DISCOVERY_DAILY_RUN_LIMIT: "5",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    TOKEN_ENCRYPTION_KEY: "",
    NODE_OPTIONS: `--import ${resolve("tests/e2e/loopback-only.mjs")}`,
  };
  const start = () =>
    launch(
      [
        "node_modules/next/dist/bin/next",
        mode,
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      env,
      mode,
    );
  let app = start();
  await waitFor(async () => (await fetch(`${origin}/api/auth`)).status === 200);
  let cookie = "",
    accountId = "";
  async function api(pathname, body) {
    const response = await fetch(`${origin}${pathname}`, {
      method: body ? "POST" : "GET",
      headers: {
        origin,
        cookie,
        "X-Sidekick-Account": accountId,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie").split(";")[0];
    return { status: response.status, body: await response.json() };
  }
  const account = await api("/api/auth", {
    action: "register",
    email: `runtime-${mode}@example.test`,
    password: "A synthetic runtime passphrase!",
  });
  assert.equal(account.status, 200);
  accountId = account.body.account.id;
  const chat = await api("/api/onboarding");
  const drafted = await api("/api/onboarding", {
    action: "message",
    message:
      "I'm Alex Rivera. DISCOVERY_PROFILE. I build TypeScript agents and want a founding engineer role.",
    revision: chat.body.chat.revision,
    requestId: crypto.randomUUID(),
  });
  assert.equal(drafted.status, 200);
  assert.equal(
    (
      await api("/api/onboarding", {
        action: "confirm",
        revision: drafted.body.revision,
        requestId: crypto.randomUUID(),
      })
    ).status,
    200,
  );
  await api("/api/discovery"); // Compile the route before timing it.
  await setScenario(1800);
  const before = performance.now();
  const post = await api("/api/discovery", {
    action: "start",
    revision: 1,
    requestId: crypto.randomUUID(),
  });
  const responseMs = Math.round(performance.now() - before);
  assert.equal(post.status, 202);
  assert.equal(post.body.discovery.status, "running");
  assert.ok(responseMs < 1000, `POST took ${responseMs}ms`);
  const immediate = await api("/api/discovery");
  assert.equal(immediate.body.discovery.status, "running");
  const ready = await waitFor(async () => {
    const s = await api("/api/discovery");
    return s.body.discovery.status === "ready" && s.body;
  });
  const completedMs = Math.round(performance.now() - before);
  assert.ok(completedMs >= 1800);
  assert.equal(ready.discovery.recommendations.length, 1);
  const runId = dbRow(path).run_id;
  await stop(app);
  app = start();
  await waitFor(async () => (await fetch(`${origin}/api/auth`)).status === 200);
  const restored = await api("/api/discovery");
  assert.equal(restored.body.discovery.status, "ready");
  assert.equal(dbRow(path).run_id, runId);

  // Destroy the client socket as soon as response headers arrive; do not read
  // or drain the body. The request has been accepted and after() must continue.
  await setScenario(1800);
  const disconnectStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(
      `${origin}/api/discovery`,
      {
        method: "POST",
        headers: {
          origin,
          cookie,
          "X-Sidekick-Account": accountId,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        const status = res.statusCode;
        res.destroy();
        req.destroy();
        resolve(status);
      },
    );
    req.on("error", reject);
    req.end(
      JSON.stringify({
        action: "refresh",
        revision: 1,
        requestId: crypto.randomUUID(),
      }),
    );
  });
  assert.equal(disconnectStatus, 202);
  assert.equal((await api("/api/discovery")).body.discovery.status, "running");
  await waitFor(
    async () => (await api("/api/discovery")).body.discovery.status === "ready",
  );

  // Verify graceful drain independently from a hard process kill.
  await setScenario(1800);
  assert.equal(
    (
      await api("/api/discovery", {
        action: "refresh",
        revision: 1,
        requestId: crypto.randomUUID(),
      })
    ).status,
    202,
  );
  const gracefulBefore = performance.now();
  await stop(app);
  const gracefulMs = Math.round(performance.now() - gracefulBefore);
  const gracefulStatus = dbRow(path).status;
  app = start();
  await waitFor(async () => (await fetch(`${origin}/api/auth`)).status === 200);
  // Dev may terminate without draining callbacks. Expire only that test row if
  // necessary, then recover before the separate kill test.
  if (gracefulStatus === "running") {
    const db = new Database(path);
    db.prepare(
      "UPDATE event_discoveries SET lease_expires_at = ? WHERE status='running'",
    ).run(Date.now() - 1);
    db.close();
    assert.equal(
      (await api("/api/discovery")).body.discovery.errorCode,
      "interrupted",
    );
  }
  await setScenario(8000);
  assert.equal(
    (
      await api("/api/discovery", {
        action: "refresh",
        revision: 1,
        requestId: crypto.randomUUID(),
      })
    ).status,
    202,
  );
  await waitFor(
    async () => (await (await fetch(`${exa}/stats`)).json()).search >= 4,
  );
  const lease = dbRow(path).lease_expires_at;
  await stop(app, "SIGKILL");
  assert.equal(dbRow(path).status, "running");
  app = start();
  await waitFor(async () => (await fetch(`${origin}/api/auth`)).status === 200);
  assert.equal((await api("/api/discovery")).body.discovery.status, "running");
  const remaining = Math.max(0, lease - Date.now() + 50);
  console.log(
    `${mode}: hard-killed run retained; waiting ${Math.ceil(remaining / 1000)}s for the real lease expiry.`,
  );
  // Bounded increments keep progress visible while testing the actual lease.
  for (let waited = 0; waited < remaining; waited += 30000) {
    await delay(Math.min(30000, remaining - waited));
    console.log(
      `${mode}: lease wait ${Math.min(waited + 30000, remaining)}ms/${remaining}ms`,
    );
  }
  const expired = await api("/api/discovery");
  assert.equal(expired.body.discovery.status, "failed");
  assert.equal(expired.body.discovery.errorCode, "interrupted");
  assert.equal(expired.body.discovery.canRefresh, true);
  await setScenario(100);
  assert.equal(
    (
      await api("/api/discovery", {
        action: "refresh",
        revision: 1,
        requestId: crypto.randomUUID(),
      })
    ).status,
    202,
  );
  await waitFor(
    async () => (await api("/api/discovery")).body.discovery.status === "ready",
  );
  const final = await api("/api/discovery");
  assert.equal(final.body.discovery.attempts, 5);
  const limited = await api("/api/discovery", {
    action: "refresh",
    revision: 1,
    requestId: crypto.randomUUID(),
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "daily_limit");
  const stats = await (await fetch(`${exa}/stats`)).json();
  assert.equal(stats.invalidKeys, 0);
  const report = {
    mode,
    postStatus: post.status,
    responseMs,
    observedImmediately: immediate.body.discovery.status,
    completedMs,
    finalStatus: ready.discovery.status,
    persistedAfterRestart: true,
    disconnectedClientStatus: disconnectStatus,
    completedAfterDisconnect: true,
    gracefulShutdownMs: gracefulMs,
    gracefulShutdownRowStatus: gracefulStatus,
    hardKill: {
      beforeExpiry: "running",
      afterExpiry: expired.body.discovery.status,
      errorCode: expired.body.discovery.errorCode,
      realLeaseMs: 90000,
      retryStatus: final.body.discovery.status,
      attempts: final.body.discovery.attempts,
    },
    globalDailyCap: { status: limited.status, code: limited.body.code },
    verifiedBySource: ready.discovery.coverage.sources,
    invalidFixtureKeys: stats.invalidKeys,
  };
  evidence.modes.push(report);
  console.log(JSON.stringify(report));
  await stop(app);
}
try {
  launch(["tests/e2e/mock-openai.mjs"], { MOCK_OPENAI_PORT: "3141" }, "openai");
  launch(["tests/e2e/mock-exa.mjs"], { MOCK_EXA_PORT: "3143" }, "exa");
  await waitFor(async () => (await fetch(`${exa}/health`)).ok);
  await waitFor(async () => (await fetch("http://127.0.0.1:3141/health")).ok);
  for (const mode of ["dev", "start"]) await verify(mode);
  const destination = process.argv[2] ?? join(folder, "evidence.json");
  writeFileSync(destination, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Runtime validation passed. Evidence: ${destination}`);
} catch (error) {
  console.error(error);
  for (const name of ["dev", "start"]) {
    try {
      console.error(
        readFileSync(join(folder, `${name}.log`), "utf8").slice(-5000),
      );
    } catch {}
  }
  process.exitCode = 1;
} finally {
  await Promise.all([...children].map((child) => stop(child, "SIGKILL")));
}
