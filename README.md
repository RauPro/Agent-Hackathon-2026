# SF Sidekick

[![CI](https://github.com/RauPro/Agent-Hackathon-2026/actions/workflows/ci.yml/badge.svg)](https://github.com/RauPro/Agent-Hackathon-2026/actions/workflows/ci.yml)

**Meet the people who matter while you're in San Francisco.** SF Sidekick learns your goal in a short chat, finds the SF events worth attending, and lets your AI agent coordinate meetings with other people's agents. You approve every step.

Built for Agent Hackathon 2026.

## How it works

1. **Tell Sidekick why you're in SF.** A conversational onboarding (text or voice) builds a structured profile with your goal, trip dates and what you offer. Nothing is saved until you select **Confirm profile**.
2. **Get the right events.** Exa searches live SF events; OpenAI structured outputs rank them against your goal with quoted evidence, date checks and honest uncertainty.
3. **Your agent talks to theirs.** Connect with people by QR code. Agents exchange permission-filtered questions, check both Google Calendars for free/busy times, and propose a 30-minute meeting that both people approve.

## Architecture

```
Next.js 16 (App Router, server routes)
├── OpenAI Responses API   onboarding, event ranking, agent dialogue, meeting times, voice
├── Exa                    personalized event retrieval
├── Google Calendar        OAuth, encrypted tokens, free/busy, optional invitations
├── Resend                 email sign-in codes
└── SQLite / Turso         accounts, profiles, network, meetings, daily usage caps
/api/cron routes           background agent matching and event refresh
```

Security and cost controls:

- Email one-time-code sign-in (hashed, single-use, 10-minute expiry, attempt and IP limits).
- Same-origin checks, stale-account headers and revocable HTTP-only sessions on every write.
- Daily caps for onboarding, voice, discovery and sign-in email, plus `SIDEKICK_AI_PAUSED=1` to stop all paid AI calls.
- Account deletion and a privacy notice at `/privacy`.

## Run locally

Requires Node 22.13 or newer.

```bash
npm install
cp .env.example .env.local   # add OPENAI_API_KEY, EXA_API_KEY and Google OAuth values
npm run dev
```

In development the sign-in code is filled in for you and printed in the server log, so no email provider is needed.

Checks:

```bash
npm run typecheck && npm run lint && npm test
npx playwright install chromium && npm run test:e2e   # uses local OpenAI, Google and Exa fixtures
```

Try the agent network with fictional profiles in an isolated demo database:

```bash
SIDEKICK_DEMO=1 DATABASE_PATH=/tmp/sidekick-network.demo.sqlite npm run dev -- --port 3001
node scripts/demo-network.mjs
```

## Documentation

- [Architecture and behavior](docs/architecture.md): detailed contracts, data model and verification notes
- [Agent social graph](docs/agent-social-graph.md)
- [Implementation plan](docs/implementation-plan.md) and [codebase review](docs/codebase-review.md)

## License

[MIT](LICENSE)
