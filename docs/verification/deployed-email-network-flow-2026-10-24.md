# Deployed email, matching, agent and meeting flow

Tested October 24, 2026, approximately 3:46–3:53 PM America/Los_Angeles, against [the production app](https://sf-sidekick-raupro.vercel.app). Deployment source: `dbe9549`.

## Scope and accounts

All mutations used the deployed user interface. Onboarding called the configured live OpenAI integration; no provider response or application state was mocked. Both profiles were explicitly fictional test users. No real user was contacted, and no Google Calendar was connected or modified.

| Test user | Email-only access | Goal | SF dates |
| --- | --- | --- | --- |
| Alex Test Rivera | `alex.flow.20261024@example.test` | Find a founding engineer role working on production AI agents and TypeScript products. | October 26–November 6, 2026 |
| Maya Test Chen | `maya.flow.20261024@example.test` | Hire a founding engineer with production AI agent, TypeScript backend and algorithms experience. | November 2–13, 2026 |

No existing real-user profile or account data was modified. The test accounts and their conversation were retained for replay. Both test users have discovery disabled, profile/goal/trip visibility limited to Connections, and events private. The browser was left in Maya's test conversation.

## Observed results

| Step | Actual result | Status |
| --- | --- | --- |
| Email entry | Each new email opened a new conversation without a password. Returning by email restored the same saved profile and network history. | Pass |
| Real chat onboarding | One natural-language paragraph per user produced the correct full name, experience, contribution, hiring/seeking goal and dates. Both drafts were reviewed and explicitly confirmed. | Pass |
| Calendar boundary | The profiles saved successfully while the Google Calendar card remained Required. No calendar connection or full calendar-verified onboarding completion was claimed. | Pass |
| Proactive matching | After both users opted in and shared profile/goal/trip with the network, Maya received Alex as a recommendation without a manual people search. | Pass |
| Match explanation | The card showed November 2–6 overlap, shared AI/agents/infrastructure/TypeScript/product/early-stage/algorithms signals, benefits for both sides and an 80/100 heuristic score. It explicitly said availability had not been checked. | Pass |
| Connection consent | Maya requested a connection. Alex saw a pending incoming request. His Agents view showed no conversations before acceptance. | Pass |
| Automatic agent exchange | Accepting the connection opened an Agents thread. Maya's Sidekick automatically requested shared professional context; Alex's Sidekick replied with authorized experience and goal. Both entries had timestamps and identified discovery as the trigger. | Pass |
| Durable conversation | The same exchange was visible from both accounts and after returning sessions/reloads. One automatic request and one reply were visible; the tested sharing changes did not duplicate them. | Pass |
| Meeting proposal | Alex proposed a fictional discussion and a clearly labeled test cafe location. The meeting began in Awaiting availability permission. | Pass |
| First availability consent | Alex entered November 3, 10 AM–noon SF time. The meeting still waited for Maya's permission; no times were committed. | Pass |
| Both availability consents | Maya entered the same window. Sidekick generated 10:00–10:30, 10:30–11:00 and 11:00–11:30 AM options, with consent and calculation entries in the timeline. | Pass |
| First time approval | Maya approved 10:00–10:30. The UI waited for Alex and exposed no calendar download. | Pass |
| Bilateral approval | Alex approved the same option. Both accounts showed Both people approved. The result survived a reload. | Pass |
| Actual calendar export | Downloaded the `.ics` through the deployed UI. Verified one event for meeting `f5fe26aa-c305-4f21-9a41-2173a5947488`, start `20261103T180000Z`, end `20261103T183000Z`, the test location, and no attendee/organizer fields. | Pass |

November 3 is Pacific Standard Time: 18:00–18:30 UTC corresponds to 10:00–10:30 AM in San Francisco. No calendar import, Google event creation, reservation or invitation was performed.

The agent exchange is a real persisted, permission-filtered `PROFILE_QUERY` request and response. This test does not claim independent free-form model conversations between agents. Matching is a deterministic heuristic.

## Finding

The incoming connection context uses the requester's perspective. Alex, who is seeking a role, saw **“Your hiring goal offers an opportunity they are seeking.”** in Maya's incoming request. The match itself and approval flow were correct, but this wording describes Maya's goal as Alex's. Use named actors or render the reason from the recipient's perspective.

Root cause: `src/components/network.tsx:974` persists `opportunity.benefits.them` as the connection context. The benefit string in `src/lib/domain/discovery.ts:170` addresses the requester, and `network.tsx:1025` renders that context unchanged for the recipient. A neutral third-person generated note would fix both directions without changing user-written QR notes. Add hiring-to-seeking and seeking-to-hiring coverage when implementing the fix. No application code was changed during this verification run.

The browser-control fill helper did not retain native date/time values. Keyboard input through the same native controls succeeded and the deployed form accepted the intended window. This was not reproduced as an application defect; blank windows were correctly rejected.

## Evidence and replay

Local screenshots and rendered-state captures are in `/private/tmp/sidekick-deployed-flow-20261024/`, including both onboarding reviews, the proactive match, automatic exchange, meeting proposal, common times, one-approval state and final approved meeting. The actual downloaded file was copied there as `09-test-meeting.ics`.

- Alex account: `736f9a93-12e1-40b4-b0f3-bd4b8c521d30`.
- Maya account: `18167646-11fd-4b1f-a3b9-6d8fc981893e`.
- As Alex: [conversation with Maya](https://sf-sidekick-raupro.vercel.app/network?view=agents&person=18167646-11fd-4b1f-a3b9-6d8fc981893e).
- As Maya: [conversation with Alex](https://sf-sidekick-raupro.vercel.app/network?view=agents&person=736f9a93-12e1-40b4-b0f3-bd4b8c521d30).

Sign out before switching test emails. Discovery remains off to keep fictional profiles out of unrelated recommendations. Google-backed availability is outside this run; the manual fallback was tested explicitly.
