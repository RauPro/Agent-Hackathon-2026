import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { expect, it, vi } from "vitest";
import { ContextStore } from "../src/lib/server/store";
import { discoveryStatus, startDiscovery, type DiscoveryDeps } from "../src/lib/server/event-discovery-service";
import { exaContents, exaSearch } from "../src/lib/server/exa";
import { extractDiscovery, planDiscovery, rankDiscovery } from "../src/lib/server/discovery-model";
import { DISCOVERY_LIMITS, eventHasEnded, quoteExists } from "../src/lib/domain/event-discovery";
import { validContext } from "./fixtures";

// Opt-in paid smoke check: one pipeline, fictional profile, disposable local DB.
// Never runs against a deployed app or submits an event registration.
it.skipIf(process.env.LIVE_EVENT_DISCOVERY_EVAL !== "1")(
  "executes one bounded real Exa/OpenAI discovery and preserves its honest result",
  async () => {
    process.loadEnvFile(".env.local");
    if (!process.env.OPENAI_API_KEY?.trim() || !process.env.EXA_API_KEY?.trim())
      throw new Error("Live event discovery requires both provider keys.");
    if (process.env.EXA_TEST_BASE_URL || (process.env.OPENAI_BASE_URL &&
      new URL(process.env.OPENAI_BASE_URL).origin !== "https://api.openai.com"))
      throw new Error("This evaluation requires the official provider endpoints.");
    vi.stubEnv("SIDEKICK_DEMO", "0");
    vi.stubEnv("VERCEL", "0");
    vi.stubEnv("DISCOVERY_DAILY_RUN_LIMIT", "1");
    const folder = mkdtempSync(join(tmpdir(), "sidekick-live-events-"));
    const path = join(folder, "fictional.sqlite");
    const store = new ContextStore(path);
    const counts = { plan: 0, search: 0, contents: 0, extract: 0, rank: 0 };
    const retrieved: string[] = [];
    const stages: Array<{ stage: string; status: "ok" | "failed"; durationMs: number }> = [];
    async function track<T>(stage: keyof typeof counts, call: () => Promise<T>): Promise<T> {
      counts[stage]++;
      const started = performance.now();
      try {
        const value = await call();
        stages.push({ stage, status: "ok", durationMs: Math.round(performance.now() - started) });
        return value;
      } catch (error) {
        stages.push({ stage, status: "failed", durationMs: Math.round(performance.now() - started) });
        throw error;
      }
    }
    const providers: Partial<DiscoveryDeps> = {
      plan: (...args) => track("plan", () => planDiscovery(...args)),
      search: (...args) => track("search", async () => {
        const result = await exaSearch(...args);
        for (const item of result) retrieved.push(item.title ?? "", item.text ?? "", ...(item.highlights ?? []));
        return result;
      }),
      contents: (...args) => track("contents", async () => {
        const result = await exaContents(...args);
        for (const item of result.results) retrieved.push(item.title ?? "", item.text ?? "", ...(item.highlights ?? []));
        return result;
      }),
      extract: (...args) => track("extract", () => extractDiscovery(...args)),
      rank: (...args) => track("rank", () => rankDiscovery(...args)),
    };
    try {
      const account = await store.continueAccount("event-live-eval@example.test");
      const context = validContext();
      context.profile.name = "Morgan Test Ellis";
      const today = Temporal.Now.plainDateISO("America/Los_Angeles");
      context.trip.start = today.toString();
      context.trip.end = today.add({ days: 21 }).toString();
      await store.save(account.token, { context, baseRevision: 0, requestId: crypto.randomUUID() });
      const startedAt = performance.now();
      const started = await startDiscovery(store, account.token, {
        action: "start", revision: 1, requestId: crypto.randomUUID(),
      }, providers);
      expect(started.run).not.toBeNull();
      await started.run!();
      const view = await discoveryStatus(store, account.token);
      const result = view.discovery!;
      const report = {
        checkedAt: new Date().toISOString(),
        fixture: "Fictional Morgan Test Ellis; disposable local database; no registrations",
        model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
        window: view.window,
        elapsedMs: Math.round(performance.now() - startedAt),
        status: result.status,
        errorCode: result.errorCode ?? null,
        counts, stages, coverage: result.coverage,
        recommendations: result.recommendations.map((event) => ({
          title: event.title, url: event.url, date: event.date, dateStatus: event.dateStatus,
          reason: event.reason, caveats: event.caveats,
          supportedFields: [...new Set(event.evidence.map((item) => item.field))],
        })),
      };
      if (process.env.EVENT_DISCOVERY_EVAL_OUTPUT)
        writeFileSync(process.env.EVENT_DISCOVERY_EVAL_OUTPUT, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
      console.log(JSON.stringify({ status: report.status, errorCode: report.errorCode,
        elapsedMs: report.elapsedMs, counts, coverage: report.coverage,
        recommendations: report.recommendations.length }));
      expect(["ready", "partial", "empty"]).toContain(result.status);
      expect(counts.plan).toBe(1);
      expect(counts.search).toBe(4);
      expect(result.coverage.sources).toHaveLength(4);
      expect(result.recommendations.length).toBeLessThanOrEqual(DISCOVERY_LIMITS.picks);
      for (const event of result.recommendations) {
        expect(eventHasEnded(event, new Date())).toBe(false);
        expect(event.date >= context.trip.start && event.date <= context.trip.end).toBe(true);
        expect(event.reason.trim()).not.toBe("");
        expect(event.location.address).toBeNull();
        for (const evidence of event.evidence)
          expect(quoteExists(evidence.quote, retrieved), `Unsupported ${evidence.field} evidence`).toBe(true);
      }
      const reopened = new ContextStore(path);
      try {
        expect((await discoveryStatus(reopened, account.token)).discovery).toEqual(result);
      } finally { reopened.close(); }
      expect(await store.db.prepare("SELECT COUNT(*) AS count FROM network_events").get()).toEqual({ count: 0 });
    } finally {
      store.close();
      rmSync(folder, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  90_000,
);
