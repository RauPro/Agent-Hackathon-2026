# SF Sidekick — Agent Hackathon 2026

A mobile-first web app that turns a visitor's goal in San Francisco into relevant people, useful conversations, and a daily plan. See the [product and implementation plan](SF-Sidekick-Implementation-Plan.md) for the full scope.

## Current phase: chat onboarding

The onboarding uses a single text input. OpenAI extracts relevant details from the conversation, maintains a structured draft, and asks one focused follow-up question when needed. Users review the draft and select **Confirm profile** before it becomes their saved context.

The UI, accessible names, metadata, validation errors, and new assistant replies are English-only. Generated profile descriptions are requested in English; proper names and user messages retain their original wording. The app refreshes its own opening greeting for existing sessions without rewriting historical model replies or changing profile revisions.

Repeated slogans, instructions, and helper captions have been removed. The interface retains actionable errors, profile status, the message input's accessible label, and the confirmation boundary.

A server-side language check examines generated replies. If a reply is not identified as English, the same OpenAI model gets one translation-only repair request. That request contains only the reply text and cannot change profile facts. Both calls share a 25-second deadline; an unsuccessful repair returns an English error and leaves the conversation unchanged. Language detection is heuristic; the live check covers the recorded scenarios, not every possible multilingual input.

Conversation drafts and confirmed profiles are stored separately in SQLite. Reloads restore the conversation; retries do not duplicate turns or confirmations. Existing profiles from the earlier form-based onboarding remain available. Unknown availability and unreviewed commitments are distinct from explicitly having no commitments.

Event discovery, ranking, participant login, introductions, registration, and calendar writes are future phases. Profile confirmation does not authorize those actions.

## Run locally

```bash
npm ci
[ -f .env.local ] || cp .env.example .env.local
npm run dev
```

Open http://127.0.0.1:3000. Use Node 22.13 or later; development and checks used Node 26. The server listens only on loopback.

Add `OPENAI_API_KEY` to `.env.local`, then restart the server. `OPENAI_MODEL` defaults to `gpt-5.4-mini`. Keep the key server-side; never use a `NEXT_PUBLIC_` prefix. Without a key, the UI shows that OpenAI is disconnected and does not simulate replies.

The integration uses the official OpenAI SDK, Responses API, structured output, and Zod, with `store: false`. See [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). Conversations are sent to OpenAI for extraction and response generation.

`DATABASE_PATH` defaults to `./data/sidekick.sqlite`. Run one Node instance with a persistent writable disk. Local SQLite is unsuitable for ephemeral function storage. Browser sessions use HttpOnly cookies and isolated server data; verified participant identity and Google OAuth are required before real introductions are enabled.

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

Playwright starts the app on `127.0.0.1:3100`, a temporary SQLite database, and an isolated provider fixture on `127.0.0.1:3101`. Test credentials and `OPENAI_BASE_URL` apply only to that process. The SDK, API, persistence, and browser are real; provider responses are simulated. No paid API calls occur in this suite.

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

`GET /api/onboarding` returns the conversation and connection status. `POST /api/onboarding` accepts `message`, `confirm`, or `reload_saved`; clients cannot supply another session identity or a model draft. `GET /api/state` and `POST /api/context` expose confirmed context. Personal responses disable shared caching.

`onboarding_chats` stores the draft and transcript. `runs` records accepted operations and their results. The model has no tools to send introductions, book meetings, or confirm a profile.

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
