# SF Sidekick — Agent Hackathon 2026

A mobile-first web app that turns a visitor's goal in San Francisco into relevant people, useful conversations, and a daily plan. See the [product and implementation plan](SF-Sidekick-Implementation-Plan.md) for the full scope.

Live app: **[sf-sidekick-raupro.vercel.app](https://sf-sidekick-raupro.vercel.app)**. Vercel hosts the application with durable Turso storage; production tracks `feat/vercel-deployment`. See the [deployment guide](docs/vercel-deployment.md) for configuration and verified release behavior. Production uses a separate database, so local accounts are not automatically available there.

## Current phase: onboarding and an agent-powered social graph

The new `/network` screen supports opt-in people discovery, persistent QR connections, permission-controlled agent queries, shared event plans, and bilateral meeting coordination. Read the [architecture and phased acceptance plan](docs/agent-social-graph.md) for data relationships, contracts, permissions, triggers, and boundaries.

Visitors enter their email and select **Continue** before onboarding. A new email creates an account; an existing email reopens its profile from any browser. Email is normalized for uniqueness, while a stable user ID owns the saved profile, conversation, and calendar connection. Sign-out revokes that browser's session without deleting the account or its progress. The header shows the signed-in email.

This controlled MVP uses email as a profile identifier, without a password, verification code or magic link. **Anyone who knows an email can reopen that profile and its connected features.** It is not proof of identity or email ownership; new accounts remain **Email unverified**. Restore verified access before opening the product to a wider audience. No email provider or extra API key is required for this phase.

The first registration in an existing anonymous browser preserves its stored draft, confirmed profile, and calendar connection. The old anonymous cookie loses access immediately. Signing in to an existing account restores that account's own data and does not merge anonymous content. The database migration adds account/session tables and one OAuth binding column; it does not delete existing profiles.

The onboarding uses a conversational input. OpenAI extracts relevant details, maintains a structured draft, and asks one focused follow-up question when needed. Vague experience, contributions, and goals prompt a narrower question or example. Profile quality gaps persist with the draft, and both the review action and server confirmation require those gaps to be resolved. A deterministic check also rejects obvious filler even if the model calls it ready. Concise specific answers are enough; employers, credentials, and metrics are optional. Users review the draft and select **Confirm profile** before it becomes their saved context.

Questions are direct, such as **“What's your full name?”** Dates can be written naturally: **“from 1 nov to 20 nov”** is interpreted internally, with the inferred year shown in ordinary language. The assistant does not request ISO dates or expose storage formats. It asks about genuine date ambiguity and uses answers already present in the conversation. Structured output extracts the updated draft before composing the next reply, so a newly answered question is not asked again.

Google Calendar supplies availability. The assistant does not ask for availability windows or a list of calendar events, even as an optional step. It may ask once about plans outside Google Calendar; “no commitments so far” answers that question. Volunteered meeting-time preferences remain optional constraints and never establish that the calendar is free. The profile preview shows these preferences only when provided and labels manually reported plans as additional commitments.

The UI, accessible names, metadata, validation errors, and new assistant replies are English-only. Generated profile descriptions are requested in English; proper names and user messages retain their original wording. The app refreshes its own opening greeting for existing sessions without rewriting historical model replies or changing profile revisions.

Repeated slogans, instructions, and helper captions have been removed. The interface retains actionable errors, profile status, the message input's accessible label, and the confirmation boundary.

A server-side language check examines generated replies. If a reply is not identified as English, the same OpenAI model gets one translation-only repair request. That request contains only the reply text and cannot change profile facts. Both calls share a 25-second deadline; an unsuccessful repair returns an English error and leaves the conversation unchanged. Language detection is heuristic; the live check covers the recorded scenarios, not every possible multilingual input.

Conversation drafts and confirmed profiles are stored separately in the database: SQLite locally and Turso/libSQL on Vercel. Reloads restore the conversation; retries do not duplicate turns or confirmations. Existing profiles from the earlier form-based onboarding remain available. Unknown availability and unreviewed commitments are distinct from explicitly having no commitments.

**Onboarding is complete only when the profile is confirmed and Google Calendar availability is verified for the current trip dates.** Users can save their profile before connecting. A connection alone, a failed check, or an old snapshot never counts as verified availability.

The calendar card starts a real Google OAuth flow, shows the connected account, and checks busy times. The primary calendar is included by default; users can include other calendars containing their commitments. Each selected calendar must return a successful free/busy result. Checks cover inclusive trip dates in San Francisco time and expire after five minutes. The open page rechecks on date/profile changes, focus, reconnecting to the network, and once a minute when visible. This is a foreground availability check, not background event mirroring.

Personalized external event discovery runs after profile confirmation. External event registration, email introductions, and Google Calendar writes remain outside this release. Users can now explicitly record a registration they completed on the event site. Network matching uses registered users and explicitly shared event plans. Meeting coordination checks both participants' availability after their permission and again before the final agreement, applies their meeting preferences and additional commitments, and requires both approvals. A calendar without busy events does not establish willingness to meet.

## Network and agent collaboration

Chat, Network and connection previews share the same header and account menu. The main chat includes an **Agent conversations** side panel on desktop; on smaller screens the same control opens a focused drawer. The panel reuses the real conversation history, sharing, answers and meeting actions. Thread links use `/onboarding?agents=1&person=<userId>`, and Back, closing the panel or changing screen size preserves the main chat. Unsent messages are saved per account in browser session storage across Chat/Network navigation and cleared after a successful send. The profile summary remains available inline.

The screen has three destinations: **For you** for recommendations, **Agents** for conversations between Sidekicks, and **People** for connections and incoming requests. Sharing and QR tools are available from the compact toolbar. Each person has a persistent agent conversation with timestamped requests, permitted replies, owner-approved answers and meeting activity. Actions open the relevant conversation directly; its URL survives reload and browser navigation.

These are recorded backend exchanges, not a simulated chat or a model's private reasoning. New responses record their actual time and whether discovery started the exchange. Older records show only known request timestamps and explicitly label saved replies whose response time was not recorded. Historical shared data is filtered again against current permissions, including per-event visibility and revoked connections.

Discovery is off by default. In **Discovery and sharing**, users choose which confirmed profile fields can be seen by connections or by the network. The QR only identifies its owner for a connection request; the other person must accept. QR rotation, removal, blocking, and visibility changes revoke future access. Declined connection requests have a 24-hour retry cooldown.

Once a connection is accepted and both profiles are confirmed, the two Sidekicks start an OpenAI-backed conversation using the context each person permits the other to see. This does not require complementary hiring goals, overlapping trips, or public discovery. Each person must share at least experience or goal with connections. Before acceptance, discovery produces proposals only; it cannot start agent communication.

The agents alternate actual model-generated turns, respond to previous messages, and refine a possible useful next step. Normal rounds have four to six agent turns; a question for the user or a pause can stop them earlier. A user answer is shared only through **Share answer and continue**. Either participant can pause; only the participant who paused can resume. Missing confirmation, missing sharing, waiting for an answer and provider errors are explicit in the conversation. No fabricated reply is substituted for a failed model request.

Both agents' model inputs contain only the permitted projections, including the agent's own context. Raw calendar data, email, private commitments and onboarding drafts are excluded. Each turn is fenced by the current relationship and permission snapshot before publication. Changed shared context starts a fresh round and clears the prior generated text and one-off answers; blocking or removal immediately hides them. Private-only context edits do not restart a round. The six-turn round and 24 completion attempts per pair per SF day bound cost; an English repair can use one additional provider request within an attempt. The adapter reuses the existing OpenAI model/key, Responses API, `store: false` and [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

Manual **Ask about an opportunity** still uses typed `PROFILE_QUERY` requests with an allowlist of profile, goal, trip and shared-event fields. It can answer from authorized information or ask its user for a one-time answer. These requests and results persist, expire after seven days, and are rechecked against current permissions on retrieval. No model can read another user's private memory or grant itself permission.

The deterministic matcher looks for reciprocal professional fit and overlapping SF dates. It supports complementary hiring/role searches, collaboration, and shared-event reunions between existing connections. Explanations show benefits for both people and the signals used. Its finite English vocabulary and conservative role matching can miss valid matches; scores are heuristics, not probabilities. Unfamiliar roles and customer/supplier matching are not covered yet. It never contacts a new person automatically. Accepted connections can converse independently of this ranking.

Confirmed profile changes, sharing settings, accepted connections and explicit event plans enqueue matching in the database. Relevant HTTP responses trigger bounded async processing with `after()`; each drain evaluates up to five eligible pairs, then advances up to two queued agent turns. Database leases prevent competing workers, and each pair commits separately without external calls inside the transaction. Discovery failures retain queued work; model failures expose Retry. Local hosting uses a 30-second process timer; Vercel uses an authenticated cron every minute on the configured Pro team. The inbox refreshes every three seconds while agents are talking and every 15 seconds otherwise. No email, push-notification service, Redis or separate worker service is required.

Meeting requests appear inside the relevant conversation in **Agents**. Each person first permits an availability comparison. Connected Google calendars are read on demand; raw busy intervals, calendar identities and event details never reach the other person. If no calendar is connected, the meeting flow accepts explicit manual windows. Provider failures never fall back to an empty calendar. Up to three 30-minute options are searched on weekdays, 9 AM–6 PM SF time, within the first 14 days of overlapping stays. A counterproposal clears previous approvals. Profile or relationship changes invalidate existing consent; reconnecting cannot revive old approvals.

After both people approve the same time and place, each can download an `.ics` file. **The file needs importing; Sidekick has not sent an invitation or written to Google Calendar.** The current Google OAuth scopes are read-only, and registration emails are unverified. No new API keys are needed for these networking phases. Live calendar creation would require an additional write grant, verified invitation addresses, retry reconciliation and cancellation support.

Events added in Network are user-reported plans. Exa recommendations offer **I registered**, which saves a self-reported registration after an explicit audience choice; opening the external link alone saves nothing. Neither action verifies admission with the event provider. No places provider is integrated. Meeting locations are proposed by a participant; venue quality, travel time and hotel proximity are not inferred.

### Isolated demo

Run an additional local server using a separate database. The `.demo.sqlite` suffix is enforced, and the interface labels demo records. The fixture script refuses a server without demo mode.

```bash
SIDEKICK_DEMO=1 DATABASE_PATH=/private/tmp/sidekick-network.demo.sqlite npm run dev -- --port 3001
# In another terminal:
node scripts/demo-network.mjs
```

Open `http://localhost:3001/login?next=%2Fnetwork` in a separate browser profile for each participant and continue with their demo email. Use `localhost` for the demo if your real session uses `127.0.0.1`; browser cookies are shared across ports on the same hostname. The script prints the fictional emails and future SF date range. It creates Raul Demo, Agustin Demo and Pedro Demo, plus an explicitly labeled meetup. It does not access Google or an event provider. Once connected, eligible demo agents use the configured OpenAI model for their conversations.

1. **Proactive networking:** sign in as Raul Demo; Agustin Demo appears automatically. Request a connection, accept as Agustin, propose a public meeting place, enter the printed manual windows from both accounts, then approve the same option and download the calendar file.
2. **QR collaboration:** show Pedro Demo's QR, scan it as Raul (camera, image or connection link), request, then accept as Pedro. Open the person’s conversation in Agents and ask about an opportunity and inspect the authorized reply in their Agents conversation. Change Pedro's confirmed goal through the existing onboarding to hiring a founding engineer with ICPC/algorithms experience. The queue detects the new fit, records an authorized agent query and updates opportunities. Their shared meetup also supports a reunion recommendation.

For a private-answer demo, set Pedro's profile visibility to private before Raul sends a query. Pedro can share a one-time answer or decline; blocking the connection immediately removes the response from future reads. For a CTO demo, confirm a compatible technical leadership goal for the seeker rather than assuming someone explicitly seeking only a founding engineer role wants a CTO role.

For a ready-to-review conversation between the fictional Raul and Pedro accounts, run `DEMO_CONVERSATION=1 node scripts/demo-network.mjs`. This optional fixture uses the normal request/accept APIs and records a real typed query and permitted reply. It does not simulate an external model or Google call.

The production server and development server share `.next`; stop the extra demo server before rebuilding. Use `npm run build` followed by `SIDEKICK_DEMO=1 DATABASE_PATH=/private/tmp/sidekick-network.demo.sqlite npm start -- --port 3001` to preview a production build.

### Personalized event discovery

Set the server-only `EXA_API_KEY` alongside `OPENAI_API_KEY`. `GET /api/discovery` reports configuration, the confirmed revision, stale flags, and the latest attempt. `POST /api/discovery` accepts `{action: "start" | "refresh", revision, requestId}` or `{action: "dismiss", revision, suggestionId}` and requires the account session, expected-account check and same Origin. Profile inputs come from the confirmed server context, never the draft or request body. A short immediate transaction claims work, then a Route Handler `after()` callback continues independently of the client connection. No database transaction spans provider calls.

The fixed pipeline has a 50-second deadline and a 90-second lease: one structured OpenAI planner call; four separate Exa searches (10 results each, up to 4,000 text characters plus highlights); at most one contents call for six incomplete candidates (8,000 characters, cache age 24 hours); one or two extraction calls for up to 16 candidates; and one ranking call over at most 10 validated candidates. The code limits each extraction candidate to 3,000 characters split between retrieved text windows. Every cached/search/highlight/enrichment text is retained during the run: a fresh crawl never replaces cached date evidence. The broad web search requests links but does not follow listing-page leads in this slice. Search failures receive at most one transient retry, respecting Retry-After and the total deadline; enrichment has no retry. Up to six Exa requests can be in flight, with at most ten search starts per second and three active pipelines across the shared database (also bounded in each process).

Planner topics (52) and audiences (13) are fixed enum vocabularies. Exa queries/objectives contain only code-owned labels, formats, San Francisco and the date window. Names, companies, products, raw profile text, email, transcripts, calendar data, coordinates and user identifiers are never sent to Exa. OpenAI receives the confirmed goal, bio, offers and meeting-format preference for planning/ranking; extraction receives public retrieved text as untrusted data. The adapters use structured output with `store:false` and no SDK retries. All event retrieval goes through Exa; the server never fetches event-platform pages directly.

Validation requires supporting quotes, a date within the remaining SF trip, and an SF venue/city. It rejects past, closed, sold-out, online-only, out-of-city and unresolved series/listing pages, known prices above budget, and verified overlaps with reported commitments. A year is confirmed only by an explicit event-specific statement. A yearless month/day plus weekday can be shown only if exactly one of this year or next year fits the trip, with a visible year-uncertainty label. Weekday contradictions are rejected. Conflicting time zones or DST-ambiguous times remove the time while retaining an otherwise supported date. Unknown zones, prices, end times, waitlists and approval requirements remain visible. Street addresses are deferred to the official event page, including when cached text is labeled public; location evidence shows only the city. Unknown or gated venue names are withheld. Multiple admission prices are variable; sponsorship is not a ticket price. These are narrow consistency checks, not a universal language parser; quoted text can still be misinterpreted by a model. Bounded windows can miss relevant facts. Recommendations never establish attendance, hiring/buying intent, admission, ticket availability, travel time, or that the user is free.

Canonical URLs deduplicate source variants (including lu.ma/luma.com and Eventbrite numeric IDs). Cross-platform identity also requires the same supported date, compatible start time and a strong normalized-title match; venue/time alone never establishes identity, and different editions/dates stay separate. Merged cards preserve all sources and prefer the explicitly named registration platform, then Luma, Eventbrite, Partiful and web. Uncertain matches stay separate.

Results belong to a stable profile owner and confirmed revision. The latest attempt is `running`, `ready`, `partial`, `empty` or `failed`; zero picks with source failures is failed, never a successful empty search. Search/enrichment failures with picks produce partial coverage. Failed refreshes retain the last successful cards and their original checked time. Expired running leases read as failed/interrupted and can be retried. Revision/run/status guards discard stale completions. Draft edits and checks older than 24 hours mark cards stale; ended events are removed on read. Missing keys create no run, and ended trips make no paid calls. Each source reports `{platform,status,results,verified}`; verified counts are before cross-platform merging. This is bounded source coverage, not a complete SF event catalog.

There are at most five attempts per owner/revision and fifteen per owner in a rolling 24 hours. `DISCOVERY_DAILY_RUN_LIMIT` defaults to 100 started pipelines across all accounts, persisted in SQLite/Turso and reset at midnight in America/Los_Angeles; set it to 0 to pause discovery. Reaching it returns `429 daily_limit` and an explicit paused message. Idempotent requests and existing running/finished results do not consume another attempt. The store prunes discovery snapshots to the current and latest older revision while retaining the operation ledger for spend caps.


### Quiet suggestions and reported registrations

A separate authenticated `/api/cron/events` check runs every 15 minutes in Vercel. Each invocation checks up to 20 due profiles within an eight-second metadata budget and starts at most one paid pipeline. Cached results are reused; automatic source refresh is no more frequent than six hours and still respects all spend caps. Profiles rotate fairly, so larger queues take multiple ticks. Automatic checks run during 8 AM–9 PM San Francisco time. Local hosting still supports confirmation/manual discovery; the periodic event check requires a scheduler calling this endpoint with `CRON_SECRET`.

The chat shows one contextual **One to consider** suggestion, with other results under **Browse events**. It does not append periodic messages to the conversation. Suggestions have a six-hour cooldown and a maximum of two per SF day. Canonical source/date identities prevent repeated suggestions across result reordering, refreshes and cross-listed platforms. Dismissal persists, registered events are excluded, and missing sources or failed calls never create a fabricated suggestion. The browser polls saved state; polling does not start paid searches.

**I registered** saves only an explicit user report. The server resolves the recommendation from that account's current profile revision and exact discovery snapshot. Existing `network_events` JSON holds the canonical event identity and trusted aliases, date and uncertainty, optional exact times, `attendance: registered`, report timestamp, source reference and chosen visibility. Missing times and uncertain years remain unknown. Opening an event page is not registration, admission or a calendar booking.

Visibility defaults to private. Both the event's audience and the account's global event-sharing permission must allow access; saving a registration never broadens global permissions. **Edit sharing** or removal revokes future access through the existing sharing rules. A shared registration enqueues people matching. Two discoverable users with common professional interests, overlapping stays and a confirmed shared event can receive a proposal, even when both seek roles. Their agents can converse only after an accepted connection, using permitted event facts labeled as user reports.

## Run locally

```bash
npm ci
[ -f .env.local ] || cp .env.example .env.local
npm run dev
```

Open http://127.0.0.1:3000. New visitors land at `/register`, returning users can use `/login`, and authenticated users continue to `/onboarding`. Old `/es` and `/?onboarding=1` links lead through the same account gate. Use Node 22.13 or later; development and checks used Node 26. The server listens only on loopback.

Add `OPENAI_API_KEY` to `.env.local`, then restart the server. `OPENAI_MODEL` defaults to `gpt-5.4-mini`. Keep the key server-side; never use a `NEXT_PUBLIC_` prefix. Without a key, the UI shows that OpenAI is disconnected and does not simulate replies.

The integration uses the official OpenAI SDK, Responses API, structured output, and Zod, with `store: false`. See [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). Conversations are sent to OpenAI for extraction and response generation.

`DATABASE_PATH` defaults to `./data/sidekick.sqlite` for local hosting with a persistent writable disk. Vercel uses `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`; local SQLite is rejected there because ephemeral functions do not share durable disk storage. Google connections store a verified Google subject and Google email under the registered account's persistent profile. The Google email may differ from the registration email; connecting it does not silently merge accounts or verify the registration email. Deduplicating actors during matching remains future work.

### Account storage and access

`users` stores the stable user ID, unique normalized email, verification state, and profile reference. The old password-hash column is retained for schema compatibility but is not used for email-only access; existing accounts and their data are preserved. The legacy `sessions` table retains the profile data; `auth_sessions` holds revocable browser sessions. Chat, operation history, and encrypted calendar tokens remain attached to the stable profile when a browser continues, signs out, or completes OAuth. A successful Google connection rotates only the initiating login cookie.

Random 32-byte session tokens are hashed in the database and sent only in HttpOnly, SameSite=Lax cookies (Secure over HTTPS). The server enforces a 30-day expiry; logout invalidates the token immediately. Continuing with the same email creates a new session for the same account without replacing its profile.

All personal API routes require an active account session, independently of page redirects. Browser requests include an expected account ID to reject stale-tab writes after switching accounts; API ownership comes from the server session. State-changing requests verify Origin. The database limits email access to ten attempts per email and 200 total attempts per 15 minutes, including successful requests. These controls preserve session isolation but do not verify who entered the email.

`GET /api/auth` returns the current account or null. `POST /api/auth` accepts `{ action: "continue", email }` or `{ action: "logout" }`; responses never include password hashes or raw session tokens. Continue atomically creates or reopens the account identified by that normalized email. Other APIs reject client-supplied ownership, and switching profiles requires signing out first.

### Configure Google Calendar

1. Enable the Google Calendar API in your Google Cloud project. Configure the OAuth consent screen and add test users while the app is in testing.
2. Create a **Web application** OAuth client. Register `http://127.0.0.1:3000/api/calendar/callback` as an authorized redirect URI. The hostname must match the browser URL exactly.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in `.env.local`.
4. Set `TOKEN_ENCRYPTION_KEY` once to 32 random bytes encoded as 64 hexadecimal characters. For example: `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`. Keep it private and stable; losing or changing it requires reconnection.
5. Restart the server, open onboarding, and choose **Connect Google Calendar**. Complete Google's consent screen yourself. The account appears first; availability is checked when valid trip dates are present.

If Google blocks sign-in while the app is in testing, add the selected Google account under **Google Auth Platform → Audience → Test users**. If consent succeeds but the Calendar API is disabled, enable `calendar-json.googleapis.com` in the same project as the OAuth client. The app distinguishes this setup error from missing user-granted permissions.

Requested scopes are `openid`, `email`, `calendar.events.freebusy`, and `calendar.calendarlist.readonly` (calendar scopes use the `https://www.googleapis.com/auth/` prefix). Calendar names and occupied intervals are read; event titles, descriptions, and attendees are not fetched or sent to OpenAI. See Google's [web OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth), and [free/busy contract](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query).

Access/refresh tokens and temporary PKCE verifiers are encrypted with AES-256-GCM, bound to the session owner. OAuth state is session-bound, single-use, and expires after ten minutes. Successful connection rotates the browser session and preserves its profile and chat. Refresh tokens renew expired access; revoked access requires reconnection. Disconnect immediately deletes local tokens and availability, then attempts Google revocation. If that cannot be verified, the UI says so. Personal responses are never shared-cacheable.

For deployment, use HTTPS, update the registered redirect and environment value, preserve the encryption key and durable database, and complete any Google consent-screen verification required for your audience and scopes. The current Vercel callback is `https://sf-sidekick-raupro.vercel.app/api/calendar/callback`; the local callback remains registered. While the OAuth app is in testing, Google authorizations and refresh tokens expire after seven days; see [Google's audience rules](https://support.google.com/cloud/answer/15549945?hl=en).

Live Google authorization and availability retrieval were verified locally with one account on October 24, 2026. The app's primary-calendar result matched an independent Google free/busy check, including the SF daylight-saving boundary, and survived manual refresh and reload. That live date range had no busy blocks; occupied intervals and provider failures remain covered by the automated fixtures. The production callback is configured, but a Google connection in the deployed application has not yet been tested. Private account details and calendar results are kept out of the repository.

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

Playwright starts the app on `127.0.0.1:3100`, a temporary SQLite database, an OpenAI fixture on `127.0.0.1:3101`, a Google fixture on `127.0.0.1:3102`, and an Exa fixture on `127.0.0.1:3103`. Test credentials, `OPENAI_BASE_URL`, `GOOGLE_TEST_BASE_URL`, and `EXA_TEST_BASE_URL` apply only to that process. The Google override accepts only HTTP loopback endpoints outside production. The SDK, OAuth routes, PKCE verification, encryption, persistence, and browser are real; provider responses and consent are simulated. No paid API calls or real Google grants occur in this suite.

Stop any existing `next dev` process for this repository before running browser checks. Set `PREVIEW_DIR` to an absolute directory to save screenshots. The flow has been inspected at 320, 390, and 1280 px in Chromium; a physical phone's keyboard and safe areas remain untested.

Live evidence, using fictional profiles in isolated sessions:

- [Original three-turn verification](docs/verification/onboarding-live-2026-10-24.json): extraction, ambiguous dates, intent correction, explicit confirmation, retries, and reload.
- [English-only verification](docs/verification/onboarding-english-2026-10-24.json): Spanish input and requests to switch languages, with English replies and profile descriptions. The earlier source record retains its original language for auditability.
- [Natural-conversation verification](docs/verification/onboarding-natural-2026-10-24.json): full-name questions, natural dates, year boundaries, ambiguity, recovery from earlier formatting requests, and commitments outside Google Calendar. Earlier verification records retain the original responses, including the date-format behavior corrected in this change.

The opt-in conversation regression suite calls OpenAI with fictional profiles and a fixed SF date; it does not read or modify app accounts. Normal `npm test` skips these paid provider calls. To rerun it with the key in `.env.local`:

```bash
LIVE_ONBOARDING_EVAL=1 npm test -- --run tests/onboarding-live.test.ts
```

The opt-in event check runs one bounded real Exa/OpenAI pipeline with a fictional profile and a disposable database. It checks evidence quotes, date constraints, honest uncertainty and persistence without registering for an event:

```bash
LIVE_EVENT_DISCOVERY_EVAL=1 npm test -- --run tests/event-discovery-live.test.ts
```

The opt-in agent conversation check calls real OpenAI with two fictional connected job seekers, disjoint travel dates and a disposable local database. It checks alternating turns, a concrete peer question, permission-filtered inputs and persistence; it never contacts real accounts or calendar providers:

```bash
LIVE_AGENT_DIALOGUE_EVAL=1 npm test -- --run tests/agent-dialogue-live.test.ts
```

### Acceptance checks

| Behavior                                                                                 | Evidence                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Draft changes do not silently update a confirmed profile                                 | Domain tests, browser flow, and live runs        |
| Invalid dates, times, and incomplete profiles cannot be confirmed                        | Domain and API tests                             |
| A lost response can be retried without duplicate effects                                 | Service and browser tests                        |
| Stale tabs cannot overwrite newer state                                                  | Revision-conflict tests                          |
| Session data stays isolated                                                              | Store and API tests                              |
| Greeting updates preserve message history and revisions                                  | Focused migration test                           |
| A non-English reply is repaired once or rejected                                         | SDK-level regression tests and live verification |
| Natural dates are normalized without asking for technical formats or manual availability | Opt-in live conversation regressions             |
| Calendar connection alone cannot complete onboarding                                     | Service and browser checks                       |
| Denied/partial Google permissions preserve the profile without claiming connection       | Browser OAuth checks                             |
| Missing or failed calendars never become empty/free availability                         | Provider and browser checks                      |
| Expiry, changed dates, and changed calendar selection invalidate readiness               | Service checks                                   |
| OAuth state rejects expiry, reuse, and another browser session                           | Store and API checks                             |
| Session rotation preserves chat/profile and invalidates the old cookie                   | Service and browser checks                       |
| A late sync cannot restore a disconnected calendar                                       | Concurrent service check                         |
| Calendar selection and connection survive reload                                         | Browser check                                    |
| Registration precedes onboarding, including legacy URLs                                  | Page and API browser checks                      |
| Duplicate normalized emails cannot replace an account                                    | Service and browser checks                       |
| Sign-in restores the same profile/calendar in another browser                            | Service and browser checks                       |
| Sign-out and session expiry revoke access without deleting progress                      | Service and API checks                           |
| Existing anonymous data is preserved only on first registration                          | Migration and service checks                     |
| Stale account requests cannot modify the newly signed-in account                         | API check                                        |
| Email-only access preserves existing accounts; sessions are revocable and requests are throttled | Service and API checks                    |

`GET /api/onboarding` returns the account, conversation, and connection status. `POST /api/onboarding` accepts `message`, `confirm`, or `reload_saved`; clients cannot supply another session identity or a model draft. `GET /api/state` and `POST /api/context` expose confirmed context. Personal responses disable shared caching.

`onboarding_chats` stores the draft and transcript. `runs` records accepted operations and their results. The model has no tools to send introductions, book meetings, or confirm a profile.

`POST /api/calendar/connect` starts OAuth; `GET /api/calendar/callback` completes it. `GET /api/calendar` returns account, selected calendars, checked date range/time, and server-derived `availabilityReady`, `profileReady`, and `onboardingComplete`. `POST /api/calendar` accepts `sync`, `select`, or `disconnect`; selection/disconnect require the current calendar revision. OAuth tokens, Google subject, and busy intervals are never returned by the status endpoint. `calendar_connections` stores the current encrypted connection and latest busy snapshot; `calendar_oauth_states` stores temporary OAuth attempts. No database transaction remains open during a Google request.

To audit the visible flow: confirm a chat profile, verify onboarding is incomplete, connect Google, confirm the account and included calendars, inspect the checked trip dates/time, then verify **Onboarding complete** appears. Change trip dates or add an unavailable calendar and verify readiness is removed. Disconnect and verify the saved profile remains but onboarding is incomplete again. API responses expose the same readiness decisions for inspection in browser developer tools.

## Project skills

Three focused skills live in `.agents/skills`. Load the skill relevant to the work; supporting product details stay in the implementation plan.

| Skill                                                                        | Use it for                                                                                            | Origin                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [sf-sidekick-mobile-first](.agents/skills/sf-sidekick-mobile-first/SKILL.md) | Phone-first onboarding, opportunity cards, preparation, daily plan, and responsive interaction states | Custom for this project                                                                             |
| [sf-sidekick-core](.agents/skills/sf-sidekick-core/SKILL.md)                 | Evidence-backed matching, domain contracts, reliable plan changes, and focused acceptance checks      | Custom for this project                                                                             |
| [web-design-guidelines](.agents/skills/web-design-guidelines/SKILL.md)       | UI and accessibility review of implemented screens                                                    | Vercel, discovered on [skills.sh](https://skills.sh/vercel-labs/agent-skills/web-design-guidelines) |

Codex discovers these project-local skills automatically. They can also be invoked explicitly, for example: “Use $sf-sidekick-mobile-first to build the opportunity screen.” See [skill discovery](https://learn.chatgpt.com/docs/customization/overview#skills).

The reusable `harvey-mobile-ui` skill is installed at `~/.codex/skills/harvey-mobile-ui/SKILL.md` and governs this project's visual treatment through `AGENTS.md`. It adapts the neutral workspace, editorial display typography and restrained controls seen in [Harvey's public product reference](https://www.harvey.ai/platform/agents), while preserving Sidekick's identity and mobile-first flows. Shared color, typography and corner tokens live in `src/app/globals.css`; no external font or UI dependency is required.

The Vercel skill is copied unchanged from [`vercel-labs/agent-skills` at `063bee94c3f4df8453406c830b0a7df0f2860278`](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/skills/web-design-guidelines/SKILL.md), retrieved on 2026-10-24. The upstream repository declares [MIT licensing](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/README.md#license). Its review rules are fetched at use time, so those rules are not pinned. In Codex, use the available web-fetch tool for its `WebFetch` step; disclose unavailable rules if the fetch fails.

These skills add instructions only; they introduce no application dependencies or services.
