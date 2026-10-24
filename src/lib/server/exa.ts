import { z } from "zod";
import { DISCOVERY_LIMITS } from "@/lib/domain/discovery";

export class ExaError extends Error {
  constructor(
    public code:
      | "not_configured"
      | "rejected"
      | "transient"
      | "timeout"
      | "invalid_response",
    public retryAfterMs = 0,
  ) {
    super(code);
  }
}
function endpoint() {
  const test = process.env.EXA_TEST_BASE_URL;
  if (!test) return "https://api.exa.ai";
  try {
    const url = new URL(test);
    if (
      process.env.NODE_ENV === "production" ||
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new ExaError("not_configured");
  }
}
export function exaConfigured() {
  try {
    endpoint();
    return !!process.env.EXA_API_KEY?.trim();
  } catch {
    return false;
  }
}
const resultSchema = z.object({
  id: z.string().optional(),
  url: z.string(),
  title: z.string().nullish(),
  text: z.string().nullish(),
  highlights: z.array(z.string()).nullish(),
  extras: z
    .object({
      links: z
        .array(z.union([z.string(), z.object({ url: z.string() })]))
        .optional(),
    })
    .nullish(),
});
const searchResponse = z.object({ results: z.array(resultSchema).max(100) });
const contentsResponse = searchResponse.extend({
  statuses: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["success", "error"]),
      source: z.enum(["cached", "crawled"]).optional(),
      error: z.unknown().optional(),
    }),
  ),
});
export type ExaResult = z.infer<typeof resultSchema>;
export type ExaContents = z.infer<typeof contentsResponse>;
export type ExaQuery = {
  query: string;
  objective: string;
  includeDomains?: string[];
  excludeDomains?: string[];
};

// Shared by requests (including development hot reloads). Bound concurrent calls
// and search starts across pipelines; 3 pipelines must not burst above 10 QPS.
const root = globalThis as typeof globalThis & {
  sidekickExa?: { active: number; starts: number[] };
};
const gate = (root.sidekickExa ??= { active: 0, starts: [] });
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
async function acquire(search: boolean, signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted();
    gate.starts = gate.starts.filter((t) => t > Date.now() - 1000);
    if (
      gate.active < DISCOVERY_LIMITS.exaConcurrent &&
      (!search || gate.starts.length < 10)
    ) {
      gate.active++;
      if (search) gate.starts.push(Date.now());
      return () => {
        gate.active--;
      };
    }
    await pause(30, signal);
  }
}
async function call(
  path: "search" | "contents",
  body: unknown,
  signal: AbortSignal,
) {
  if (!exaConfigured()) throw new ExaError("not_configured");
  const base = endpoint();
  // Enrichment is a single best-effort call, without a second paid contents call.
  for (let attempt = 0; attempt < (path === "search" ? 2 : 1); attempt++) {
    let release: (() => void) | undefined;
    const timeout = AbortSignal.timeout(DISCOVERY_LIMITS.searchTimeoutMs);
    const requestSignal = AbortSignal.any([signal, timeout]);
    try {
      release = await acquire(path === "search", requestSignal);
      const response = await fetch(`${base}/${path}`, {
        method: "POST",
        cache: "no-store",
        redirect: "error",
        signal: requestSignal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.EXA_API_KEY!,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const transient = [429, 500, 503].includes(response.status);
        const retry = response.headers.get("retry-after");
        const retryMs = retry
          ? /^\d+(?:\.\d+)?$/.test(retry)
            ? Number(retry) * 1000
            : Math.max(0, Date.parse(retry) - Date.now())
          : 200;
        throw new ExaError(
          transient ? "transient" : "rejected",
          Number.isFinite(retryMs) ? retryMs : 200,
        );
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new ExaError("invalid_response");
      }
      return data;
    } catch (error) {
      if (signal.aborted) throw new ExaError("timeout");
      const mapped =
        error instanceof ExaError
          ? error
          : new ExaError(timeout.aborted ? "timeout" : "transient", 200);
      if (
        path !== "search" ||
        attempt > 0 ||
        !["transient", "timeout"].includes(mapped.code)
      )
        throw mapped;
      release?.();
      release = undefined;
      // The caller's 55-second signal also covers Retry-After and queue time.
      try {
        await pause(mapped.retryAfterMs, signal);
      } catch {
        throw new ExaError("timeout");
      }
    } finally {
      release?.();
    }
  }
  throw new ExaError("transient");
}
export async function exaSearch(
  input: ExaQuery,
  signal: AbortSignal,
): Promise<ExaResult[]> {
  const data = await call(
    "search",
    {
      query: input.query,
      objective: input.objective,
      ...(input.includeDomains ? { includeDomains: input.includeDomains } : {}),
      ...(input.excludeDomains ? { excludeDomains: input.excludeDomains } : {}),
      type: "auto",
      numResults: 10,
      userLocation: "US",
      contents: {
        text: { maxCharacters: 4000 },
        highlights: {
          query:
            "event date, start time, time zone, venue, address, price, registration status",
        },
        ...(input.excludeDomains ? { extras: { links: 3 } } : {}),
      },
    },
    signal,
  );
  const parsed = searchResponse.safeParse(data);
  if (!parsed.success) throw new ExaError("invalid_response");
  return parsed.data.results.slice(0, 10);
}
export async function exaContents(
  urls: string[],
  signal: AbortSignal,
): Promise<ExaContents> {
  if (!urls.length || urls.length > DISCOVERY_LIMITS.enrich)
    throw new ExaError("rejected");
  const data = await call(
    "contents",
    {
      urls,
      text: { maxCharacters: 8000 },
      maxAgeHours: 24,
      livecrawlTimeout: 8000,
    },
    signal,
  );
  const parsed = contentsResponse.safeParse(data);
  if (!parsed.success) throw new ExaError("invalid_response");
  return parsed.data;
}
