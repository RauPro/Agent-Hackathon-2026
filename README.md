# SF Sidekick — Agent Hackathon 2026

A mobile-first web app that turns a visitor's goal in San Francisco into relevant people, useful conversations, and a daily plan. See the [product and implementation plan](SF-Sidekick-Implementation-Plan.md) for the full scope.

## Current phase: chat onboarding and Google Calendar

The onboarding uses a single text input. OpenAI extracts relevant details from the conversation, maintains a structured draft, and asks one focused follow-up question when needed. Users review the draft and select **Confirm profile** before it becomes their saved context.

The UI, accessible names, metadata, validation errors, and new assistant replies are English-only. Generated profile descriptions are requested in English; proper names and user messages retain their original wording. The app refreshes its own opening greeting for existing sessions without rewriting historical model replies or changing profile revisions.

Repeated slogans, instructions, and helper captions have been removed. The interface retains actionable errors, profile status, the message input's accessible label, and the confirmation boundary.

A server-side language check examines generated replies. If a reply is not identified as English, the same OpenAI model gets one translation-only repair request. That request contains only the reply text and cannot change profile facts. Both calls share a 25-second deadline; an unsuccessful repair returns an English error and leaves the conversation unchanged. Language detection is heuristic; the live check covers the recorded scenarios, not every possible multilingual input.

Conversation drafts and confirmed profiles are stored separately in SQLite. Reloads restore the conversation; retries do not duplicate turns or confirmations. Existing profiles from the earlier form-based onboarding remain available. Unknown availability and unreviewed commitments are distinct from explicitly having no commitments.

**Onboarding is complete only when the profile is confirmed and Google Calendar availability is verified for the current trip dates.** Users can save their profile before connecting. A connection alone, a failed check, or an old snapshot never counts as verified availability.

The calendar card starts a real Google OAuth flow, shows the connected account, and checks busy times. The primary calendar is included by default; users can include other calendars containing their commitments. Each selected calendar must return a successful free/busy result. Checks cover inclusive trip dates in San Francisco time and expire after five minutes. The open page rechecks on date/profile changes, focus, reconnecting to the network, and once a minute when visible. This is a foreground availability check, not background event mirroring.

Event discovery, ranking, cross-device participant login, introductions, registration, and calendar writes are future phases. Profile confirmation and read-only calendar consent do not authorize those actions. Future scheduling must recheck both participants' availability immediately before booking, apply their meeting preferences, and require both participants' consent. A calendar without busy events does not establish willingness to meet.

## Run locally

```bash
npm ci
[ -f .env.local ] || cp .env.example .env.local
npm run dev
```

Open http://127.0.0.1:3000. Use Node 22.13 or later; development and checks used Node 26. The server listens only on loopback.

Add `OPENAI_API_KEY` to `.env.local`, then restart the server. `OPENAI_MODEL` defaults to `gpt-5.4-mini`. Keep the key server-side; never use a `NEXT_PUBLIC_` prefix. Without a key, the UI shows that OpenAI is disconnected and does not simulate replies.

The integration uses the official OpenAI SDK, Responses API, structured output, and Zod, with `store: false`. See [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). Conversations are sent to OpenAI for extraction and response generation.

`DATABASE_PATH` defaults to `./data/sidekick.sqlite`. Run one Node instance with a persistent writable disk. Local SQLite is unsuitable for ephemeral function storage. Browser sessions use HttpOnly cookies and isolated server data. Google connections store a verified Google subject and email for the current browser profile; account recovery, merging profiles across browsers, and deduplicating actors during matching are not implemented yet.

### Configure Google Calendar

1. Enable the Google Calendar API in your Google Cloud project. Configure the OAuth consent screen and add test users while the app is in testing.
2. Create a **Web application** OAuth client. Register `http://127.0.0.1:3000/api/calendar/callback` as an authorized redirect URI. The hostname must match the browser URL exactly.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in `.env.local`.
4. Set `TOKEN_ENCRYPTION_KEY` once to 32 random bytes encoded as 64 hexadecimal characters. For example: `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`. Keep it private and stable; losing or changing it requires reconnection.
5. Restart the server, open onboarding, and choose **Connect Google Calendar**. Complete Google's consent screen yourself. The account appears first; availability is checked when valid trip dates are present.

Requested scopes are `openid`, `email`, `calendar.events.freebusy`, and `calendar.calendarlist.readonly` (calendar scopes use the `https://www.googleapis.com/auth/` prefix). Calendar names and occupied intervals are read; event titles, descriptions, and attendees are not fetched or sent to OpenAI. See Google's [web OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth), and [free/busy contract](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query).

Access/refresh tokens and temporary PKCE verifiers are encrypted with AES-256-GCM, bound to the session owner. OAuth state is session-bound, single-use, and expires after ten minutes. Successful connection rotates the browser session and preserves its profile and chat. Refresh tokens renew expired access; revoked access requires reconnection. Disconnect immediately deletes local tokens and availability, then attempts Google revocation. If that cannot be verified, the UI says so. Personal responses are never shared-cacheable.

For deployment, use HTTPS, update the registered redirect and environment value, retain the encryption key and SQLite disk, and complete any Google consent-screen verification required for your audience and scopes. Google authorization and real-account availability remain unverified until the user completes a live connection; automated checks use labeled fixtures.

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

Playwright starts the app on `127.0.0.1:3100`, a temporary SQLite database, an OpenAI fixture on `127.0.0.1:3101`, and a Google fixture on `127.0.0.1:3102`. Test credentials, `OPENAI_BASE_URL`, and `GOOGLE_TEST_BASE_URL` apply only to that process. The Google override accepts only HTTP loopback endpoints outside production. The SDK, OAuth routes, PKCE verification, encryption, persistence, and browser are real; provider responses and consent are simulated. No paid API calls or real Google grants occur in this suite.

Stop any existing `next dev` process for this repository before running browser checks. Set `PREVIEW_DIR` to an absolute directory to save screenshots. The flow has been inspected at 320, 390, and 1280 px in Chromium; a physical phone's keyboard and safe areas remain untested.

Live evidence, using fictional profiles in isolated sessions:

- [Original three-turn verification](docs/verification/onboarding-live-2026-10-24.json): extraction, ambiguous dates, intent correction, explicit confirmation, retries, and reload.
- [English-only verification](docs/verification/onboarding-english-2026-10-24.json): Spanish input and requests to switch languages, with English replies and profile descriptions. The earlier source record retains its original language for auditability.

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
| Calendar connection alone cannot complete onboarding | Service and browser checks |
| Denied/partial Google permissions preserve the profile without claiming connection | Browser OAuth checks |
| Missing or failed calendars never become empty/free availability | Provider and browser checks |
| Expiry, changed dates, and changed calendar selection invalidate readiness | Service checks |
| OAuth state rejects expiry, reuse, and another browser session | Store and API checks |
| Session rotation preserves chat/profile and invalidates the old cookie | Service and browser checks |
| A late sync cannot restore a disconnected calendar | Concurrent service check |
| Calendar selection and connection survive reload | Browser check |

`GET /api/onboarding` returns the conversation and connection status. `POST /api/onboarding` accepts `message`, `confirm`, or `reload_saved`; clients cannot supply another session identity or a model draft. `GET /api/state` and `POST /api/context` expose confirmed context. Personal responses disable shared caching.

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
