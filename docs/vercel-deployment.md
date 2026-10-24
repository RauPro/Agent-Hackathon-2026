# Vercel deployment

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
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Existing Google web OAuth client. |
| `GOOGLE_REDIRECT_URI` | `https://<production-domain>/api/calendar/callback`, also registered in Google Cloud. |
| `TOKEN_ENCRYPTION_KEY` | Stable 32-byte AES key encoded as 64 hex characters. Never rotate casually or expose to the client. |
| `CRON_SECRET` | Long random secret authorizing scheduled discovery requests. |

No environment variable uses `NEXT_PUBLIC_`. Source uploads exclude `.env` files, local databases, caches and verification artifacts. Existing local account/calendar data is not automatically uploaded by a deployment.

Vercel supports Node 24 and 22; the current package engine range selects supported Node 24 there. Local development remains compatible with the existing Node installation. [Vercel Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)

## Persistence and work execution

The async database adapter supports the existing local SQLite files and remote `@libsql/client/web` transactions. All services and route handlers await reads and mutations. Nested operations share the transaction executor and use savepoints. Additive schema initialization is awaited before application queries. A persistent database-purpose marker prevents a demo deployment from silently reusing a production database.

Onboarding and calendar operations use database leases instead of process-local in-flight sets. Meeting approvals still recheck the relationship, profile revision, calendar revision and conflicts in a transaction after external reads. Google/OpenAI requests never run inside a database transaction.

Vercel skips the process timer. Confirmed onboarding/profile changes and network mutations use `after()` to process bounded queued work. `GET /api/cron/network` requires `Authorization: Bearer <CRON_SECRET>`. The queue persists a cursor and source version, skips ineligible profiles, rotates progress fairly and uses a lease to prevent competing workers. Each pair commits separately, keeping transactions short for remote libSQL. [Turso transaction reference](https://docs.turso.tech/sdk/ts/reference)

The verified Vercel team is Pro, so `vercel.json` schedules one check per minute. Hobby deployments must change the schedule to a daily expression such as `0 8 * * *`; their event-triggered work still runs after mutations. Cron failures leave durable work queued for retry. [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)

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
