import {
  DISCOVERY_LIMITS,
  PROACTIVE_EVENT_LIMITS,
  isDiscoveryError,
  DiscoveryError,
  canonicalUrl,
  deduplicate,
  discoveryWindow,
  emptyCoverage,
  eventHasEnded,
  prefilter,
  sanitizePlan,
  searchQueries,
  validateCandidate,
  validateRanking,
  type Candidate,
  type DiscoveryRequest,
  type DiscoveryResult,
  type DiscoveryView,
} from "@/lib/domain/event-discovery";
import { ContextStore, getStore } from "./store";
import { randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { assistantConfigured } from "./onboarding-model";
import { exaConfigured, exaContents, exaSearch, type ExaResult } from "./exa";
import {
  extractDiscovery,
  planDiscovery,
  rankDiscovery,
} from "./discovery-model";
export type DiscoveryDeps = {
  search: typeof exaSearch;
  contents: typeof exaContents;
  plan: typeof planDiscovery;
  extract: typeof extractDiscovery;
  rank: typeof rankDiscovery;
  now: () => Date;
};
const defaultDeps: DiscoveryDeps = {
  search: exaSearch,
  contents: exaContents,
  plan: planDiscovery,
  extract: extractDiscovery,
  rank: rankDiscovery,
  now: () => new Date(),
};
type ActiveRun = {
  owner: string;
  revision: number;
  controller: AbortController;
};
const root = globalThis as typeof globalThis & {
  sidekickDiscoveries?: Map<string, ActiveRun>;
};
const active = (root.sidekickDiscoveries ??= new Map<string, ActiveRun>());
export const discoveryConfigured = () =>
  assistantConfigured() && exaConfigured();
export async function discoveryStatus(
  store: ContextStore,
  token: string | undefined,
  now = new Date(),
): Promise<DiscoveryView> {
  const state = await store.read(token);
  const owner = await store.calendarOwner(token);
  const chat = await store.readChat(token);
  const row = await store.readDiscovery(token, now);
  const saved: DiscoveryResult | null = row?.result_json
    ? JSON.parse(row.result_json)
    : null;
  const draftChanged =
    !!state?.context &&
    !(chat.confirmed && chat.baseRevision === state.revision);
  const outdated =
    !!saved &&
    now.getTime() - Date.parse(saved.checkedAt) > DISCOVERY_LIMITS.dayMs;
  const window = state?.context ? discoveryWindow(state.context, now) : null;
  const counts = await store.discoveryCounts(owner, state?.revision ?? 0, now);
  const dailyLimitReached = (await store.discoveryDailyUsage(now)).reached;
  return {
    configured: discoveryConfigured(),
    profileRevision: state?.context ? state.revision : null,
    stale: draftChanged || outdated,
    draftChanged,
    outdated,
    tripPast: !!state?.context && !window,
    dailyLimitReached,
    window,
    suggestion: await store.eventSuggestion(owner, now, false, false, row?.run_id ?? null),
    discovery: row
      ? {
          revision: row.profile_revision,
          status: row.status,
          attempts: row.attempts,
          canRefresh:
            !dailyLimitReached &&
            counts.owner < DISCOVERY_LIMITS.perOwner &&
            counts.revision < DISCOVERY_LIMITS.perRevision &&
            row.status !== "running" &&
            !!window,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          checkedAt: saved?.checkedAt ?? null,
          ...(row.error_code ? { errorCode: row.error_code } : {}),
          recommendations:
            saved?.recommendations.filter(
              (event) => !eventHasEnded(event, now),
            ) ?? [],
          coverage:
            (await store.discoveryCoverage(owner, row.run_id)) ??
            saved?.coverage ??
            emptyCoverage(),
        }
      : null,
  };
}
const texts = (r: ExaResult) =>
  [r.title ?? "", r.text ?? "", ...(r.highlights ?? [])].filter(Boolean);
function needsEnrichment(c: Candidate) {
  const all = c.texts.join("\n");
  return (
    !/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d|\d{4}-\d{2}-\d{2}/i.test(
      all,
    ) ||
    !/\d(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}/i.test(all) ||
    !/\b(san francisco|sf|941\d{2})\b/i.test(all)
  );
}
// Claim atomically. The caller schedules run() via after(), independent of
// the browser's request.signal. No transaction survives any provider await.
export async function startDiscovery(
  store: ContextStore,
  token: string | undefined,
  request: DiscoveryRequest,
  overrides: Partial<DiscoveryDeps> = {},
) {
  if (!discoveryConfigured()) throw new DiscoveryError("not_configured");
  const deps = { ...defaultDeps, ...overrides };
  const now = deps.now();
  const capacity = active.size < DISCOVERY_LIMITS.concurrent;
  const claim = await store.claimDiscovery(token, request, now, capacity);
  const run = prepareDiscoveryRun(store, claim, request, deps, true);
  return { view: await discoveryStatus(store, token, now), run };
}

function prepareDiscoveryRun(
  store: ContextStore,
  claim: Awaited<ReturnType<ContextStore["claimDiscovery"]>>,
  request: DiscoveryRequest,
  deps: DiscoveryDeps,
  explicitlyRequested: boolean,
  timeBudgetMs: number = DISCOVERY_LIMITS.deadlineMs,
) {
  if (!claim.claimed) return null;
  const owner = claim.owner;
  for (const pending of active.values())
    if (pending.owner === owner && pending.revision !== request.revision)
      pending.controller.abort();
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(timeBudgetMs);
  const signal = AbortSignal.any([controller.signal, deadline]);
  active.set(claim.row.run_id, {
    owner,
    revision: request.revision,
    controller,
  });
  // Release abandoned reservations even if the process never invokes after().
  const reservation = setTimeout(() => {
    controller.abort();
    active.delete(claim.row.run_id);
  }, DISCOVERY_LIMITS.leaseMs);
  reservation.unref?.();
  let invoked = false;
  const run = async () => {
    if (invoked) return;
    invoked = true;
    const coverage = emptyCoverage();
    let stage = "planner";
    // Enforce the total deadline even for a broken injected provider that ignores signals.
    const bounded = async <T>(promise: Promise<T>): Promise<T> => {
      signal.throwIfAborted();
      let abort: () => void = () => {};
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            abort = () => reject(new Error("timeout"));
            signal.addEventListener("abort", abort, { once: true });
          }),
        ]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    };
    try {
      const plan = sanitizePlan(
        await bounded(deps.plan(claim.context, signal)),
        claim.context,
      );
      const window = discoveryWindow(claim.context, deps.now());
      if (!window) throw new Error("trip_past");
      stage = "search";
      const queries = searchQueries(plan, window);
      const retrieved = await bounded(
        Promise.allSettled(
          queries.map((q) =>
            deps.search(
              {
                query: q.query,
                objective: q.objective,
                ...("includeDomains" in q
                  ? { includeDomains: q.includeDomains }
                  : { excludeDomains: q.excludeDomains }),
              },
              signal,
            ),
          ),
        ),
      );
      const groups = retrieved.map((r, index) => {
        const platform = queries[index].platform;
        coverage.sources.push({
          platform,
          status: r.status === "fulfilled" ? "ok" : "failed",
          results: r.status === "fulfilled" ? r.value.length : 0,
          verified: 0,
        });
        return r.status === "fulfilled"
          ? r.value.map((item) => ({
              id: "",
              platform,
              url: item.url,
              title: item.title ?? "",
              texts: texts(item),
            }))
          : [];
      });
      const candidates = prefilter(groups);
      coverage.candidates = candidates.length;
      const enrich = candidates
        .filter(needsEnrichment)
        .slice(0, DISCOVERY_LIMITS.enrich);
      if (enrich.length) {
        stage = "enrichment";
        try {
          const extra = await bounded(
            deps.contents(
              enrich.map((c) => c.url),
              signal,
            ),
          );
          coverage.enrichment = "ok";
          for (const c of enrich) {
            const item = extra.results.find(
              (r) => canonicalUrl(r.url)?.url === c.url,
            );
            const status = extra.statuses.find(
              (s) => canonicalUrl(s.id)?.url === c.url || s.id === item?.id,
            );
            if (!item || status?.status !== "success")
              coverage.enrichment = "failed";
            if (item) c.texts = [...new Set([...c.texts, ...texts(item)])];
          }
        } catch {
          coverage.enrichment = "failed";
        }
      }
      stage = "extract";
      const batches: Candidate[][] = [];
      for (let i = 0; i < candidates.length; i += DISCOVERY_LIMITS.extractBatch)
        batches.push(candidates.slice(i, i + DISCOVERY_LIMITS.extractBatch));
      const extracted = (
        await bounded(Promise.all(batches.map((b) => deps.extract(b, signal))))
      ).flat();
      if (
        extracted.length !== candidates.length ||
        new Set(extracted.map((f) => f.candidateId)).size !== extracted.length
      )
        throw new Error("invalid_extraction");
      const valid = candidates.flatMap((c) => {
        const f = extracted.find((e) => e.candidateId === c.id);
        const result = f
          ? validateCandidate(c, f, claim.context, deps.now())
          : null;
        return result && !eventHasEnded(result, deps.now()) ? [result] : [];
      });
      const merged = deduplicate(valid);
      if (claim.context.preferences.budgetUsd !== null)
        for (const c of merged) {
          if (
            ["unknown", "varies"].includes(c.price.kind) &&
            !c.caveats.includes("Can't confirm it fits your budget.")
          )
            c.caveats.push("Can't confirm it fits your budget.");
        }
      for (const source of coverage.sources)
        source.verified = valid.filter(
          (c) => c.platform === source.platform,
        ).length;
      coverage.verified = merged.length;
      // Prefer date certainty when selecting the bounded ranking pool.
      const pool = merged
        .sort(
          (a, b) =>
            Number(a.dateStatus !== "confirmed") -
            Number(b.dateStatus !== "confirmed"),
        )
        .slice(0, DISCOVERY_LIMITS.rank);
      stage = "rank";
      const picks = pool.length
        ? validateRanking(
            await bounded(deps.rank(claim.context, pool, signal)),
            pool,
          )
        : [];
      signal.throwIfAborted();
      const incomplete =
        coverage.sources.some((s) => s.status === "failed") ||
        coverage.enrichment === "failed";
      const status = picks.length
        ? incomplete
          ? "partial"
          : "ready"
        : incomplete
          ? "failed"
          : "empty";
      await store.finishDiscovery(
        owner,
        request.revision,
        claim.row.run_id,
        status,
        status === "failed"
          ? null
          : {
              recommendations: picks,
              coverage,
              checkedAt: deps.now().toISOString(),
            },
        coverage,
        status === "failed" ? "sources_failed" : null,
        deps.now(),
      );
    } catch {
      await store.finishDiscovery(
        owner,
        request.revision,
        claim.row.run_id,
        "failed",
        null,
        coverage,
        deadline.aborted
          ? "timeout"
          : controller.signal.aborted
            ? "interrupted"
            : `${stage}_failed`,
        deps.now(),
      );
    } finally {
      clearTimeout(reservation);
      active.delete(claim.row.run_id);
    }
    await store.eventSuggestion(owner, deps.now(), true, explicitlyRequested);
  };
  return run;
}

// One bounded research pipeline per cron invocation. Checking is frequent;
// research and user-visible suggestions each have independent quiet budgets.
export async function drainEventDiscovery(
  store = getStore(),
  overrides: Partial<DiscoveryDeps> = {},
) {
  if (!discoveryConfigured()) return { configured: false, checked: 0, started: 0 };
  const deps = { ...defaultDeps, ...overrides };
  const startedAt = Date.now();
  const lease = await store.db.acquireLease("event-discovery-worker", 60_000);
  if (!lease) return { configured: true, checked: 0, started: 0 };
  let checked = 0;
  try {
    // Metadata-only checks are bounded by count and wall time, leaving room for
    // one provider pipeline and its final database writes within a 60s route.
    while (checked < PROACTIVE_EVENT_LIMITS.checksPerRun && Date.now() - startedAt < 8_000) {
      const now = deps.now();
      const due = await store.claimProactiveDiscoveryCheck(now);
      if (!due) break;
      checked++;
      await store.eventSuggestion(due.owner, now, true);
      const local = Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO("America/Los_Angeles");
      if (local.hour < 8 || local.hour >= 21) continue;
      const row = await store.readDiscoveryForOwner(due.owner, now);
      // Provider failures stay visible and cannot consume a fresh paid run on
      // every tick. Cached profiles do not block checks for other due users.
      if (row && (row.status === "running"
        || now.getTime() - Date.parse(row.started_at) < PROACTIVE_EVENT_LIMITS.refreshMs)) continue;
      const request: DiscoveryRequest = {
        action: row ? "refresh" : "start", revision: due.revision, requestId: randomUUID(),
      };
      try {
        const claim = await store.claimDiscoveryForOwner(
          due.owner, request, now, active.size < DISCOVERY_LIMITS.concurrent, true,
        );
        // The 50-second cap shrinks if database checks have already used time.
        const remainingMs = Math.max(1, Math.min(DISCOVERY_LIMITS.deadlineMs, 52_000 - (Date.now() - startedAt)));
        const run = prepareDiscoveryRun(store, claim, request, deps, false, remainingMs);
        if (run) {
          await run();
          return { configured: true, checked, started: 1 };
        }
      } catch (error) {
        if (!isDiscoveryError(error)) throw error;
        if (error.code === "daily_limit" || error.code === "busy") break;
      }
    }
    return { configured: true, checked, started: 0 };
  } finally {
    await store.db.releaseLease("event-discovery-worker", lease);
  }
}
