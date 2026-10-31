# Vercel deployment

Live application: **[sf-sidekick-raupro.vercel.app](https://sf-sidekick-raupro.vercel.app)**. The Vercel project `sf-sidekick-raupro` tracks `main` in `RauPro/Agent-Hackathon-2026`; pushes to that branch deploy to production. The first verified production deployment used commit `4b87832`.

Sidekick keeps one Next.js application. Vercel hosts the UI and route handlers; a remote SQLite-compatible libSQL database stores accounts, context, relationships, agent exchanges, meeting approvals and queued work. Local SQLite remains available for development. A writable local database is deliberately rejected when `VERCEL=1` because Vercel functions do not share persistent local storage. [Vercel guidance](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel)

## Deployment configuration

| Variable | Purpose |
| --- | --- |
| `TURSO_DATABASE_URL` | Secure remote libSQL database endpoint. |
| `TURSO_AUTH_TOKEN` | Server-only database credential. |
| `DATABASE_PURPOSE` | `production`, or `demo` for a separately provisioned demo database. |
| `SIDEKICK_DEMO` | `0` for production. `1` requires `DATABASE_PURPOSE=demo` for a remote database. |
| `OPENAI_API_KEY` | Existing onboarding model key, stored only in server environment variables. |
| `OPENAI_MODEL` | Optional model override; current default remains unchanged. |
| `EXA_API_KEY` | Server-only key enabling personalized event recommendations after profile confirmation. Without it, onboarding, Calendar and Network remain usable. |
| `DISCOVERY_DAILY_RUN_LIMIT` | Maximum event discovery pipelines per SF calendar day across the shared database; defaults to 100. Set to 0 to pause new event searches. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Existing Google web OAuth client. |
| `GOOGLE_REDIRECT_URI` | `https://<production-domain>/api/calendar/callback`, also registered in Google Cloud. |
| `TOKEN_ENCRYPTION_KEY` | Stable 32-byte AES key encoded as 64 hex characters. Never rotate casually or expose to the client. |
| `CRON_SECRET` | Long random secret authorizing scheduled discovery requests. |

No environment variable uses `NEXT_PUBLIC_`. Source uploads exclude `.env` files, local databases, caches and verification artifacts. Existing local account/calendar data is not automatically uploaded by a deployment.

The production-only Turso integration uses `sf-sidekick-production` in Virginia on its free Starter plan. Preview and development environments are not connected to this database. New production users register separately from their local accounts. Google Cloud retains the local callback and also authorizes `https://sf-sidekick-raupro.vercel.app/api/calendar/callback`.

Google OAuth remains in **Testing**, so only configured Google test users can connect their calendars. Publishing the consent screen for a broader audience is a separate Google configuration and verification step.

The controlled MVP uses email-only profile access: Continue creates a new account or reopens an existing email's account without a password or email verification. Existing profiles and calendar connections remain attached to their account. Knowing the email is sufficient to access that account, so this configuration assumes a trusted cohort rather than verified identity.

Vercel supports Node 24 and 22; the current package engine range selects supported Node 24 there. Local development remains compatible with the existing Node installation. [Vercel Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)

## Persistence and work execution

The async database adapter supports the existing local SQLite files and remote `@libsql/client/web` transactions. All services and route handlers await reads and mutations. Nested operations share the transaction executor and use savepoints. Additive schema initialization is awaited before application queries. A persistent database-purpose marker prevents a demo deployment from silently reusing a production database.

Onboarding and calendar operations use database leases instead of process-local in-flight sets. Meeting approvals still recheck the relationship, profile revision, calendar revision and conflicts in a transaction after external reads. Google/OpenAI requests never run inside a database transaction.

`agent_dialogues` adds one durable row per accepted connection for the current AI conversation round. Existing connections are reconciled on network reads and worker triggers. Each worker invocation advances at most two model turns after bounded discovery; each model attempt has a 12-second deadline, and each pair has a 45-second fenced lease. All replies recheck current confirmed context, sharing and relationship before committing. Six agent turns per round and 24 completion attempts per pair per SF day prevent unbounded iteration. No new environment variables or provider credentials are needed. These limits do not authorize a meeting or a calendar write.

Event discovery uses separate `event-discovery` domain/service modules so it does not replace the people matcher. Its claims, results, daily budget and three-run concurrency cap persist in the same database. The route schedules the provider pipeline with `after()`, bounded to 50 seconds within the configured 60-second function duration. Interrupted runs expire after a 90-second lease and can be retried. Verify live Exa/OpenAI recommendation quality and the deployed background run before release; local provider fixtures do not establish those results.

Vercel skips the process timer. Confirmed onboarding/profile changes and network mutations use `after()` to process bounded queued work. `GET /api/cron/network` requires `Authorization: Bearer <CRON_SECRET>`. The queue persists a cursor and source version, skips ineligible profiles, rotates progress fairly and uses a lease to prevent competing workers. Each pair commits separately, keeping transactions short for remote libSQL. [Turso transaction reference](https://docs.turso.tech/sdk/ts/reference)

The verified Vercel team is Pro. `vercel.json` schedules `/api/cron/network` every minute for people matching and connected dialogue, and `/api/cron/events` every 15 minutes for quiet event discovery. Both require the existing `CRON_SECRET`. The event worker checks up to 20 due profiles within an eight-second metadata budget and starts at most one paid pipeline; it subtracts elapsed metadata time from the pipeline deadline to leave time for final database writes. Source refresh has a six-hour interval, while visible suggestions have a six-hour cooldown and a maximum of two per SF day during 8 AM–9 PM. Larger queues rotate across ticks. No periodic messages are added to chat. Hobby deployments must change the schedule to a daily expression such as `0 8 * * *`; their event-triggered work still runs after mutations. Cron failures leave durable work queued for retry. [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)

## Release verification

Before deploying, run typecheck, lint, unit/service tests, browser regressions and a production build. Tests exercise local SQLite and the libSQL client transaction API against a disposable local database; those checks are not proof of live Turso connectivity.

After connecting the actual database and deploying, verify:

1. Registration and returning login retain state across separate requests and function instances.
2. Confirmed context, QR identity and conversations survive reload.
3. A second account cannot inspect another account's private data or approve its requests.
4. Triggered matching drains work without duplicate requests.
5. Cron rejects missing or incorrect secrets and processes authenticated requests.
6. Google OAuth returns to the production domain and reads authorized availability.
7. Logs contain no provider tokens, database credentials or private calendar contents.

Calendar writing remains outside the current feature set. Bilaterally approved meetings produce an ICS export; deployment does not add Google write permissions or send invitations.

### Verified release — October 24, 2026

- Local validation: 141 unit/service tests and 27 browser checks passed; nine opt-in paid OpenAI tests were skipped. Typecheck, lint, production build and `VERCEL=1` build passed.
- Actual Turso: 19 checks covered persistence across server restarts, private defaults, QR connections, agent responses, matching, bilateral manual-availability consent and ICS export.
- Deployed application: 18 assertions across 32 authenticated requests covered registration, returning login, session revocation, identity checks, QR connections, agent history and visibility revocation. Public registration and unauthenticated access boundaries also passed.
- Real OpenAI onboarding succeeded with fictional input in 2.78 seconds. Ordinary authenticated requests had a 175 ms median in the recorded run.
- Cron rejected an unauthenticated request with 401 and accepted the configured bearer secret with 200 (`processed: 0` on the empty queue).
- Synthetic accounts stayed undiscoverable and were removed by their exact recorded IDs. No local accounts, private calendars or demo community were copied into production.
- The Google production callback was saved and verified after reopening the client. Live Google authorization and availability remain verified only locally; the deployed app still needs a user-completed Google connection test.

### Connected dialogue verification

The iterative conversation release (`dac6d88`) passed 182 unit/service checks, 30 browser checks, lint and the production build. Ten paid-provider tests are opt-in; the new dialogue live evaluation was run separately and passed with four actual OpenAI turns between fictional peers with the same goal and non-overlapping trips.

The [deployed verification](verification/deployed-agent-dialogue-2026-10-24.json) used the two existing fictional connected accounts. Their conversation automatically started, completed four alternating turns, and returned identical persisted text and message IDs in both sessions after reload. All 12 HTTP checks succeeded, discovery remained off, and the temporary test logins were signed out. No meeting, calendar or profile mutation was made by that verification. The real connected-user UI also displayed the new alternating conversation; its private transcript is not stored in this repository.

## Public launch checklist

These steps need account access and are not automated by the repository:

- **Sign-in email:** create a Resend API key, verify the sending domain and set `RESEND_API_KEY` and `AUTH_EMAIL_FROM` in Production. Without them, production refuses to issue sign-in codes. Existing sessions created before code verification stop working; users sign in again with a code.
- **Spend controls:** review `ONBOARDING_DAILY_LIMIT`, `ONBOARDING_ACCOUNT_DAILY_LIMIT`, `VOICE_DAILY_LIMIT`, `VOICE_ACCOUNT_DAILY_LIMIT`, `SIGN_IN_EMAIL_DAILY_LIMIT` and `DISCOVERY_DAILY_RUN_LIMIT`. Set `SIDEKICK_AI_PAUSED=1` to stop every OpenAI and Exa call immediately. Configure billing alerts and hard limits in OpenAI, Exa and Vercel.
- **Google OAuth:** while the consent screen is in testing, only listed test users can connect a calendar and their tokens expire after seven days. Publish the app and complete Google verification for the Calendar scopes, using `/privacy` as the privacy policy URL, before expecting calendar connections from the public.
- **Cron:** the network cron runs every minute, which requires a paid Vercel plan.
- **Observability:** enable Vercel Web Analytics and log drains or an error tracker for the launch window.
