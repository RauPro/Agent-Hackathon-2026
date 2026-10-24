# Event discovery integration review — October 24, 2026

Integrated `codex/personalized-event-discovery` at `9e18373` with `origin/main` at `09fd453` on the local branch `codex/integrate-personalized-events`. Their common base was `1d68625`. The original main checkout and T3 worktree were left unchanged. No push or deployment was performed.

The user explicitly selected main's email-and-password authentication. The newer email-only change `dbe9549` on `feat/vercel-deployment` is excluded. The deployment guide identifies that separate branch as the production branch; this integration does not change the deployed application or its settings.

## Integration fixes

- Preserved main's people-matching `discovery.ts` and `discovery-service.ts`. Event discovery now uses separate `event-discovery` modules, avoiding an add/add conflict that could replace the network matcher.
- Adapted event endpoints, services and persistence to main's asynchronous database API. Session checks and writes are awaited, transactions use async callbacks, and inserts use positional parameters supported by the libSQL adapter.
- Added the event schema through the existing additive database initialization. Retained main's account, QR, network, meeting and Calendar behavior. Legacy anonymous profile rotation also rekeys event results.
- Enforced the three-pipeline concurrency cap through the shared database transaction, alongside the persistent daily and per-owner budgets. Process-local limits alone would not protect multiple server instances.
- Tightened time evidence checks: minutes and AM/PM must match a source time; a bare number or timezone offset cannot establish an event time.
- Deferred exact street addresses to the official event page. A live check showed cached source data can expose a location that the current page gates behind registration. Location evidence now shows the city; unknown or gated venue names are withheld. The app does not perform a fresh, authoritative visibility check for every venue.

## Validation

- Final `npm run typecheck`, `npm run lint` and `npm run build`: passed.
- Final `npm test`: **252 passed, 9 skipped**. The skipped tests are the existing opt-in paid onboarding evaluations.
- Full browser suite on the integrated branch: **35 passed**. Covered sign-in, isolation, onboarding, Google OAuth and availability fixtures, personalized events, QR connections, agent exchanges and bilateral meetings.
- After the final location changes, the focused event browser suite passed again: **8 passed**.
- Added SQLite and libSQL-adapter tests covering persisted event results alongside a QR relationship and Calendar selection, cross-account isolation, restart, stale revisions, duplicate claims, shared daily budget and capacity recovery. libSQL tests use its actual client API backed by a disposable file, not a live Turso database.
- Visually inspected event cards at 320, 390 and 1280 px. Browser tests also check overflow and keyboard access. No physical-phone validation was performed.
- [Runtime evidence](events-integration-runtime-2026-10-24.json): the merged persistence implementation returned warm `202` responses in 8 ms (dev) and 6 ms (production), then completed fixture discovery in 1.886 s and 1.864 s. Results survived restart and client disconnection. Production completed pending work on SIGTERM. Both modes recovered after a real 90-second lease expired following SIGKILL and enforced `429 daily_limit`. These timings use loopback provider fixtures, not live API latency. The final time/location domain guards were separately covered by unit and browser tests.

## Live provider smoke checks and limits

Two bounded pipelines used a fictional engineering profile, real Exa/OpenAI credentials, and disposable local databases. No real user profile, Google account, Turso database, registration or calendar mutation was involved. Each pipeline made four Exa searches, one contents call, a planner call, two extraction calls and a ranking call.

The first finished `ready` in 14.337 seconds with one recommendation. The second finished `ready` in 11.242 seconds with two recommendations after three candidates passed validation. Each retrieved 40 search results and inspected at most 16 candidates. The second run still classified a cached Luma address as public; this motivated the final unconditional street-address guard, tested locally without a third paid run. A comparison with the [official Luma page](https://luma.com/poqk5sgn) showed that its current location requires registration.

These checks establish that the real adapters execute and can produce recommendations. They do not establish exhaustive event coverage or consistently strong recommendations for every goal/date range. Live Turso connectivity and deployed background execution were not retested. Production requires `EXA_API_KEY`; without it, the events section reports setup pending while Calendar and Network remain usable. Event recommendations do not automatically become shared Network plans or registrations.

Before release, review the local integration branch, refresh against main if it advances, and test the chosen deployment with its own configuration. Do not publish the original event branch directly over the newer main changes.
