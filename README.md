# SF Sidekick — Agent Hackathon 2026

A mobile-first web app that turns a visitor's goal in San Francisco into relevant people, useful conversations, and a daily plan. See the [product and implementation plan](SF-Sidekick-Implementation-Plan.md) for the full scope.

## Current phase: accounts, onboarding, Google Calendar, and event discovery

New visitors register with email and password before onboarding. Returning users sign in to the same account from any browser. Email is normalized for uniqueness, while a stable user ID owns the saved profile, conversation, and calendar connection. Sign-out revokes that browser's session without deleting the account or its progress. The header shows the signed-in email.

Registration does not prove ownership of an email address: new accounts explicitly remain **Email unverified**. Email verification and password recovery require a separate implementation and are not available yet. Do not use unverified addresses for introductions or participant identity checks. No email provider or extra API key is required for this phase.

The first registration in an existing anonymous browser preserves its stored draft, confirmed profile, and calendar connection. The old anonymous cookie loses access immediately. Signing in to an existing account restores that account's own data and does not merge anonymous content. The database migration adds account/session tables and one OAuth binding column; it does not delete existing profiles.

The onboarding uses a single text input. OpenAI extracts relevant details from the conversation, maintains a structured draft, and asks one focused follow-up question when needed. Users review the draft and select **Confirm profile** before it becomes their saved context.

Questions are direct, such as **“What's your full name?”** Dates can be written naturally: **“from 1 nov to 20 nov”** is interpreted internally, with the inferred year shown in ordinary language. The assistant does not request ISO dates or expose storage formats. It asks about genuine date ambiguity and uses answers already present in the conversation. Structured output extracts the updated draft before composing the next reply, so a newly answered question is not asked again.

Google Calendar supplies availability. The assistant does not ask for availability windows or a list of calendar events, even as an optional step. It may ask once about plans outside Google Calendar; “no commitments so far” answers that question. Volunteered meeting-time preferences remain optional constraints and never establish that the calendar is free. The profile preview shows these preferences only when provided and labels manually reported plans as additional commitments.

The UI, accessible names, metadata, validation errors, and new assistant replies are English-only. Generated profile descriptions are requested in English; proper names and user messages retain their original wording. The app refreshes its own opening greeting for existing sessions without rewriting historical model replies or changing profile revisions.

Repeated slogans, instructions, and helper captions have been removed. The interface retains actionable errors, profile status, the message input's accessible label, and the confirmation boundary.

A server-side language check examines generated replies. If a reply is not identified as English, the same OpenAI model gets one translation-only repair request. That request contains only the reply text and cannot change profile facts. Both calls share a 25-second deadline; an unsuccessful repair returns an English error and leaves the conversation unchanged. Language detection is heuristic; the live check covers the recorded scenarios, not every possible multilingual input.

Conversation drafts and confirmed profiles are stored separately in SQLite. Reloads restore the conversation; retries do not duplicate turns or confirmations. Existing profiles from the earlier form-based onboarding remain available. Unknown availability and unreviewed commitments are distinct from explicitly having no commitments.

**Onboarding is complete only when the profile is confirmed and Google Calendar availability is verified for the current trip dates.** Users can save their profile before connecting. A connection alone, a failed check, or an old snapshot never counts as verified availability.

The calendar card starts a real Google OAuth flow, shows the connected account, and checks busy times. The primary calendar is included by default; users can include other calendars containing their commitments. Each selected calendar must return a successful free/busy result. Checks cover inclusive trip dates in San Francisco time and expire after five minutes. The open page rechecks on date/profile changes, focus, reconnecting to the network, and once a minute when visible. This is a foreground availability check, not background event mirroring.

After explicit profile confirmation, event discovery searches Luma, Eventbrite, Partiful, and the broader web through Exa, checks event evidence and constraints, and ranks up to three options for the saved goal. It works before Google Calendar is connected. Cards show dated sources, prices or missing prices, goal-fit suggestions, uncertainty, and official registration links. Opening a page does not register you. Introductions, registration, payment, calendar writes, people matching, notifications, and crawling are outside this feature. Calendar behavior and the definition of onboarding completion above are unchanged.

### Personalized event discovery

Set the server-only `EXA_API_KEY` alongside `OPENAI_API_KEY`. `GET /api/discovery` reports configuration, the confirmed revision, stale flags, and the latest attempt. `POST /api/discovery` accepts only `{action: "start" | "refresh", revision, requestId}` and requires the account session, expected-account check and same Origin. Profile inputs come from the confirmed server context, never the draft or request body. A short immediate transaction claims work, then a Route Handler `after()` callback continues independently of the client connection. No database transaction spans provider calls.

The fixed pipeline has a 55-second deadline and a 90-second lease: one structured OpenAI planner call; four separate Exa searches (10 results each, up to 4,000 text characters plus highlights); at most one contents call for six incomplete candidates (8,000 characters, cache age 24 hours); one or two extraction calls for up to 16 candidates; and one ranking call over at most 10 validated candidates. The code limits each extraction candidate to 3,000 characters split between retrieved text windows. Every cached/search/highlight/enrichment text is retained during the run: a fresh crawl never replaces cached date evidence. The broad web search requests links but does not follow listing-page leads in this slice. Search failures receive at most one transient retry, respecting Retry-After and the total deadline; enrichment has no retry. Up to six Exa requests can be in flight, with at most ten search starts per second and three active pipelines per process.

Planner topics (52) and audiences (13) are fixed enum vocabularies. Exa queries/objectives contain only code-owned labels, formats, San Francisco and the date window. Names, companies, products, raw profile text, email, transcripts, calendar data, coordinates and user identifiers are never sent to Exa. OpenAI receives the confirmed goal, bio, offers and meeting-format preference for planning/ranking; extraction receives public retrieved text as untrusted data. The adapters use structured output with `store:false` and no SDK retries. All event retrieval goes through Exa; the server never fetches event-platform pages directly.

Validation requires supporting quotes, a date within the remaining SF trip, and an SF venue/city. It rejects past, closed, sold-out, online-only, out-of-city and unresolved series/listing pages, known prices above budget, and verified overlaps with reported commitments. A year is confirmed only by an explicit event-specific statement. A yearless month/day plus weekday can be shown only if exactly one of this year or next year fits the trip, with a visible year-uncertainty label. Weekday contradictions are rejected. Conflicting time zones or DST-ambiguous times remove the time while retaining an otherwise supported date. Unknown zones, prices, end times, hidden addresses, waitlists and approval requirements remain visible. Multiple admission prices are variable; sponsorship is not a ticket price. These are narrow consistency checks, not a universal language parser; quoted text can still be misinterpreted by a model. Bounded windows can miss relevant facts. Recommendations never establish attendance, hiring/buying intent, admission, ticket availability, travel time, or that the user is free.

Canonical URLs deduplicate source variants (including lu.ma/luma.com and Eventbrite numeric IDs). Cross-platform identity also requires the same supported date, compatible start time and a strong normalized-title match; venue/time alone never establishes identity, and different editions/dates stay separate. Merged cards preserve all sources and prefer the explicitly named registration platform, then Luma, Eventbrite, Partiful and web. Uncertain matches stay separate.

Results belong to a stable profile owner and confirmed revision. The latest attempt is `running`, `ready`, `partial`, `empty` or `failed`; zero picks with source failures is failed, never a successful empty search. Search/enrichment failures with picks produce partial coverage. Failed refreshes retain the last successful cards and their original checked time. Expired running leases read as failed/interrupted and can be retried. Revision/run/status guards discard stale completions. Draft edits and checks older than 24 hours mark cards stale; ended events are removed on read. Missing keys create no run, and ended trips make no paid calls. Each source reports `{platform,status,results,verified}`; verified counts are before cross-platform merging. This is bounded source coverage, not a complete SF event catalog.

There are at most five attempts per owner/revision and fifteen per owner in a rolling 24 hours. `DISCOVERY_DAILY_RUN_LIMIT` defaults to 100 started pipelines across all accounts, persisted in SQLite and reset at midnight in America/Los_Angeles; set it to 0 to pause discovery. Reaching it returns `429 daily_limit` and an explicit paused message. Idempotent requests and existing running/finished results do not consume another attempt. The store prunes discovery snapshots to the current and latest older revision while retaining the operation ledger for spend caps. Every terminal events state offers **Continue to Google Calendar**, which focuses the unchanged calendar card.

## Run locally

```bash
npm ci
[ -f .env.local ] || cp .env.example .env.local
npm run dev
```

Open http://127.0.0.1:3000. New visitors land at `/register`, returning users can use `/login`, and authenticated users continue to `/onboarding`. Old `/es` and `/?onboarding=1` links lead through the same account gate. Use Node 22.13 or later; development and checks used Node 26. The server listens only on loopback.

Add `OPENAI_API_KEY` to `.env.local`, then restart the server. `OPENAI_MODEL` defaults to `gpt-5.4-mini`. Keep the key server-side; never use a `NEXT_PUBLIC_` prefix. Without a key, the UI shows that OpenAI is disconnected and does not simulate replies.

The integration uses the official OpenAI SDK, Responses API, structured output, and Zod, with `store: false`. See [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). Conversations are sent to OpenAI for extraction and response generation.

`DATABASE_PATH` defaults to `./data/sidekick.sqlite`. Run one Node instance with a persistent writable disk. Local SQLite is unsuitable for ephemeral function storage. Google connections store a verified Google subject and Google email under the registered account's persistent profile. The Google email may differ from the registration email; connecting it does not silently merge accounts or verify the registration email. Deduplicating actors during matching remains future work.

### Account storage and access

`users` stores the stable user ID, unique normalized email, salted password hash, verification state, and profile reference. The legacy `sessions` table retains the profile data; `auth_sessions` holds revocable browser logins. Chat, operation history, and encrypted calendar tokens remain attached to the stable profile when a browser signs in, signs out, or completes OAuth. A successful Google connection rotates only the initiating login cookie.

Passwords use Node's asynchronous scrypt with a random 16-byte salt, `N=131072`, `r=8`, and `p=1`. Passwords allow 15–128 characters at registration, preserve whitespace, and support password managers. Random 32-byte login tokens are hashed in SQLite and sent only in HttpOnly, SameSite=Lax cookies (Secure over HTTPS). The server enforces a 30-day expiry; logout invalidates the token immediately. See [Node scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback) and [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

All personal API routes require an authenticated account, independently of page redirects. Browser requests include an expected account ID to reject stale-tab writes after switching accounts; ownership always comes from the server session. State-changing requests verify Origin. Login failures use the same message for an unknown email and an incorrect password. SQLite tracks a conservative limit of ten attempts per email and 200 total attempts per 15 minutes, and the process runs at most two password hashes at once. Successful authentication clears that email's counter. A public deployment needs HTTPS and an appropriate trusted-proxy/IP abuse policy in addition to these MVP limits.

`GET /api/auth` returns the current account or null. `POST /api/auth` accepts `register`, `login`, or `logout`; responses never include password hashes or raw login tokens. No email address or user ID supplied by a client grants access to another account.

### Configure Google Calendar

1. Enable the Google Calendar API in your Google Cloud project. Configure the OAuth consent screen and add test users while the app is in testing.
2. Create a **Web application** OAuth client. Register `http://127.0.0.1:3000/api/calendar/callback` as an authorized redirect URI. The hostname must match the browser URL exactly.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in `.env.local`.
4. Set `TOKEN_ENCRYPTION_KEY` once to 32 random bytes encoded as 64 hexadecimal characters. For example: `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`. Keep it private and stable; losing or changing it requires reconnection.
5. Restart the server, open onboarding, and choose **Connect Google Calendar**. Complete Google's consent screen yourself. The account appears first; availability is checked when valid trip dates are present.

If Google blocks sign-in while the app is in testing, add the selected Google account under **Google Auth Platform → Audience → Test users**. If consent succeeds but the Calendar API is disabled, enable `calendar-json.googleapis.com` in the same project as the OAuth client. The app distinguishes this setup error from missing user-granted permissions.

Requested scopes are `openid`, `email`, `calendar.events.freebusy`, and `calendar.calendarlist.readonly` (calendar scopes use the `https://www.googleapis.com/auth/` prefix). Calendar names and occupied intervals are read; event titles, descriptions, and attendees are not fetched or sent to OpenAI. See Google's [web OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth), and [free/busy contract](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query).

Access/refresh tokens and temporary PKCE verifiers are encrypted with AES-256-GCM, bound to the session owner. OAuth state is session-bound, single-use, and expires after ten minutes. Successful connection rotates the browser session and preserves its profile and chat. Refresh tokens renew expired access; revoked access requires reconnection. Disconnect immediately deletes local tokens and availability, then attempts Google revocation. If that cannot be verified, the UI says so. Personal responses are never shared-cacheable.

For deployment, use HTTPS, update the registered redirect and environment value, retain the encryption key and SQLite disk, and complete any Google consent-screen verification required for your audience and scopes. While the OAuth app is in testing, Google authorizations and refresh tokens expire after seven days; see [Google's audience rules](https://support.google.com/cloud/answer/15549945?hl=en).

Live Google authorization and availability retrieval were verified with one account on October 24, 2026. The app's primary-calendar result matched an independent Google free/busy check, including the SF daylight-saving boundary, and survived manual refresh and reload. That live date range had no busy blocks; occupied intervals and provider failures remain covered by the automated fixtures. Private account details and calendar results are kept out of the repository.

## Verification

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm start
```

Browser checks:

```bash
npx playwright install chromium
npm run test:e2e
```

Playwright starts the app on `127.0.0.1:3100`, a temporary SQLite database, an OpenAI fixture on `127.0.0.1:3101`, a Google fixture on `127.0.0.1:3102`, and an Exa fixture on `127.0.0.1:3103`. Fake credentials, `OPENAI_BASE_URL`, `GOOGLE_TEST_BASE_URL`, and `EXA_TEST_BASE_URL` override `.env.local` only for that process. The test preload refuses non-loopback application fetches; the Exa fixture rejects any key except its fake key. The Google and Exa overrides accept only HTTP loopback endpoints outside production. The SDK, OAuth routes, PKCE verification, encryption, persistence, and browser are real; provider responses and consent are simulated. No paid API calls or real Google grants occur in this suite.

Discovery unit tests inject a fixed SF clock and provider functions. Browser fixtures use trip/event dates relative to today in SF and model output selected by structured-output schema name, with no live calls. They exercise loading/cards, reload and second-tab idempotency, goal revisions, outages/retry, partial coverage, past-only results, keyboard access, and 320/390/1280 px reflow.

To validate background execution against the actual dev and production runtimes after building:

```bash
npm run build
node tests/discovery-runtime.mjs docs/verification/discovery-runtime-2026-10-24.json
```

The runtime harness starts loopback fixtures on 3141/3143 and the app on 3140 (`next dev`) and 3150 (`next start`) with temporary databases and fake keys. It checks fast 202 responses, background completion, persistence across restart, socket disconnects, graceful shutdown, real 90-second lease expiry after SIGKILL, retry, and the global daily cap. Production deliberately rejects `EXA_TEST_BASE_URL`; a test-process-only fetch preload redirects Exa's production hostname to the local fixture instead. No production exception is added to the adapter. The generated JSON records actual timings and any dev/start shutdown difference.

[Recorded fixture runtime evidence](docs/verification/discovery-runtime-2026-10-24.json) shows background completion and persistence in both modes. In this run, `next start` drained the pending callback on SIGTERM; `next dev` exited with a running row, which recovered through lease expiry and retry. A hard kill required that recovery in both modes. This is in-process background work, not a durable worker queue. The disconnect check destroys the client socket after response headers, without reading the body, and verifies that the accepted run completes.

Stop any existing `next dev` process for this repository before running browser checks. Set `PREVIEW_DIR` to an absolute directory to save screenshots. The flow has been inspected at 320, 390, and 1280 px in Chromium; a physical phone's keyboard and safe areas remain untested.

Live evidence, using fictional profiles in isolated sessions:

- [Original three-turn verification](docs/verification/onboarding-live-2026-10-24.json): extraction, ambiguous dates, intent correction, explicit confirmation, retries, and reload.
- [English-only verification](docs/verification/onboarding-english-2026-10-24.json): Spanish input and requests to switch languages, with English replies and profile descriptions. The earlier source record retains its original language for auditability.
- [Natural-conversation verification](docs/verification/onboarding-natural-2026-10-24.json): full-name questions, natural dates, year boundaries, ambiguity, recovery from earlier formatting requests, and commitments outside Google Calendar. Earlier verification records retain the original responses, including the date-format behavior corrected in this change.

The opt-in conversation regression suite calls OpenAI with fictional profiles and a fixed SF date; it does not read or modify app accounts. Normal `npm test` skips these paid provider calls. To rerun it with the key in `.env.local`:

```bash
LIVE_ONBOARDING_EVAL=1 npm test -- --run tests/onboarding-live.test.ts
```

### Acceptance checks

| Behavior | Evidence |
| --- | --- |
| Draft changes do not silently update a confirmed profile | Domain tests, browser flow, and live runs |
| Invalid dates, times, and incomplete profiles cannot be confirmed | Domain and API tests |
| A lost response can be retried without duplicate effects | Service and browser tests |
| Stale tabs cannot overwrite newer state | Revision-conflict tests |
| Session data stays isolated | Store and API tests |
| Greeting updates preserve message history and revisions | Focused migration test |
| A non-English reply is repaired once or rejected | SDK-level regression tests and live verification |
| Natural dates are normalized without asking for technical formats or manual availability | Opt-in live conversation regressions |
| Calendar connection alone cannot complete onboarding | Service and browser checks |
| Denied/partial Google permissions preserve the profile without claiming connection | Browser OAuth checks |
| Missing or failed calendars never become empty/free availability | Provider and browser checks |
| Expiry, changed dates, and changed calendar selection invalidate readiness | Service checks |
| OAuth state rejects expiry, reuse, and another browser session | Store and API checks |
| Session rotation preserves chat/profile and invalidates the old cookie | Service and browser checks |
| A late sync cannot restore a disconnected calendar | Concurrent service check |
| Calendar selection and connection survive reload | Browser check |
| Registration precedes onboarding, including legacy URLs | Page and API browser checks |
| Duplicate normalized emails cannot replace an account | Service and browser checks |
| Sign-in restores the same profile/calendar in another browser | Service and browser checks |
| Sign-out and session expiry revoke access without deleting progress | Service and API checks |
| Existing anonymous data is preserved only on first registration | Migration and service checks |
| Stale account requests cannot modify the newly signed-in account | API check |
| Passwords are salted, sessions are revocable, and guessing is throttled | Service and API checks |

`GET /api/onboarding` returns the account, conversation, and connection status. `POST /api/onboarding` accepts `message`, `confirm`, or `reload_saved`; clients cannot supply another session identity or a model draft. `GET /api/state` and `POST /api/context` expose confirmed context. Personal responses disable shared caching.

`onboarding_chats` stores the draft and transcript. `runs` records accepted operations and their results. The model has no tools to send introductions, book meetings, or confirm a profile.

`POST /api/calendar/connect` starts OAuth; `GET /api/calendar/callback` completes it. `GET /api/calendar` returns account, selected calendars, checked date range/time, and server-derived `availabilityReady`, `profileReady`, and `onboardingComplete`. `POST /api/calendar` accepts `sync`, `select`, or `disconnect`; selection/disconnect require the current calendar revision. OAuth tokens, Google subject, and busy intervals are never returned by the status endpoint. `calendar_connections` stores the current encrypted connection and latest busy snapshot; `calendar_oauth_states` stores temporary OAuth attempts. No database transaction remains open during a Google request.

To audit the visible flow: confirm a chat profile, verify onboarding is incomplete, connect Google, confirm the account and included calendars, inspect the checked trip dates/time, then verify **Onboarding complete** appears. Change trip dates or add an unavailable calendar and verify readiness is removed. Disconnect and verify the saved profile remains but onboarding is incomplete again. API responses expose the same readiness decisions for inspection in browser developer tools.

## Project skills

Three focused skills live in `.agents/skills`. Load the skill relevant to the work; supporting product details stay in the implementation plan.

| Skill | Use it for | Origin |
| --- | --- | --- |
| [sf-sidekick-mobile-first](.agents/skills/sf-sidekick-mobile-first/SKILL.md) | Phone-first onboarding, opportunity cards, preparation, daily plan, and responsive interaction states | Custom for this project |
| [sf-sidekick-core](.agents/skills/sf-sidekick-core/SKILL.md) | Evidence-backed matching, domain contracts, reliable plan changes, and focused acceptance checks | Custom for this project |
| [web-design-guidelines](.agents/skills/web-design-guidelines/SKILL.md) | UI and accessibility review of implemented screens | Vercel, discovered on [skills.sh](https://skills.sh/vercel-labs/agent-skills/web-design-guidelines) |

Codex discovers these project-local skills automatically. They can also be invoked explicitly, for example: “Use $sf-sidekick-mobile-first to build the opportunity screen.” See [skill discovery](https://learn.chatgpt.com/docs/customization/overview#skills).

The Vercel skill is copied unchanged from [`vercel-labs/agent-skills` at `063bee94c3f4df8453406c830b0a7df0f2860278`](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/skills/web-design-guidelines/SKILL.md), retrieved on 2026-10-24. The upstream repository declares [MIT licensing](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/README.md#license). Its review rules are fetched at use time, so those rules are not pinned. In Codex, use the available web-fetch tool for its `WebFetch` step; disclose unavailable rules if the fetch fails.

These skills add instructions only; they introduce no application dependencies or services.
