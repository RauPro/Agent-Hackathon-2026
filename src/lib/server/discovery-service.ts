import {
  DISCOVERY_LIMITS,
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
} from "@/lib/domain/discovery";
import { ContextStore } from "./store";
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

export function discoveryStatus(
  store: ContextStore,
  token: string | undefined,
  now = new Date(),
): DiscoveryView {
  const state = store.read(token);
  const owner = store.calendarOwner(token);
  const chat = store.readChat(token);
  const row = store.readDiscovery(token, now);
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
  const counts = store.discoveryCounts(owner, state?.revision ?? 0, now);
  const dailyLimitReached = store.discoveryDailyUsage(now).reached;
  return {
    configured: discoveryConfigured(),
    profileRevision: state?.context ? state.revision : null,
    stale: draftChanged || outdated,
    draftChanged,
    outdated,
    tripPast: !!state?.context && !window,
    dailyLimitReached,
    window,
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
            store.discoveryCoverage(owner, row.run_id) ??
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

// Claim synchronously. The caller schedules run() via after(), independent of
// the browser's request.signal. No transaction survives any provider await.
export function startDiscovery(
  store: ContextStore,
  token: string | undefined,
  request: DiscoveryRequest,
  overrides: Partial<DiscoveryDeps> = {},
) {
  if (!discoveryConfigured()) throw new DiscoveryError("not_configured");
  const deps = { ...defaultDeps, ...overrides };
  const now = deps.now();
  const owner = store.calendarOwner(token);
  const capacity = active.size < DISCOVERY_LIMITS.concurrent;
  const claim = store.claimDiscovery(token, request, now, capacity);
  if (!claim.claimed)
    return { view: discoveryStatus(store, token, now), run: null };
  for (const pending of active.values())
    if (pending.owner === owner && pending.revision !== request.revision)
      pending.controller.abort();
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(DISCOVERY_LIMITS.deadlineMs);
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
      store.finishDiscovery(
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
      store.finishDiscovery(
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
  };
  return { view: discoveryStatus(store, token, now), run };
}
