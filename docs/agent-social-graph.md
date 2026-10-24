# Agent-powered social graph

## Architecture decision

Keep one Next.js Node application and the existing SQLite database on durable disk. Reuse `users.id` as person identity and derive `agent:<userId>`; no agent process or agent table per person. Reuse the existing authenticated sessions, confirmed `sessions.context_json`, context revision, encryption and Google free/busy adapter. Keep onboarding unchanged apart from enqueueing discovery after a confirmed change and linking to the network screen.

The new network store shares the existing SQLite connection. A deterministic matching function and a typed request dispatcher are the agent runtime for this slice. They do not require a model call or another API key. OpenAI remains the onboarding provider.

## Existing and missing components

| Component     | Reuse or addition                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity      | Existing email/password accounts and revocable sessions; registration email remains unverified.                                            |
| Context       | Existing confirmed bio, contribution, goal, SF trip, preferences and additional commitments. Draft conversation is never shared.           |
| Calendar      | Existing encrypted per-account credentials and selected-calendar free/busy. Read-only OAuth cannot create Google events.                   |
| Relationships | Add one canonical connection per pair, directional blocks, explicit request/accept and meeting context.                                    |
| Permissions   | Add discovery opt-in and private/friends/network visibility for profile, goal, trip and shared events.                                     |
| Requests      | Persist typed agent requests and responses, recipient questions, expiry, correlation and idempotency.                                      |
| Discovery     | Add a coalescing SQLite queue and an in-process periodic drain. No Redis, cron service or external agent framework.                        |
| Inbox         | Derive from opportunities, connection requests, agent requests and meetings. No separate notification table.                               |
| Events        | No provider exists. Add only explicitly shared user-reported attendance and isolated demo fixtures.                                        |
| Places        | No provider exists. Accept a proposed public meeting place and map link. Do not claim venue verification, proximity or travel feasibility. |

## Minimum data model

- Existing `users` → `sessions` (confirmed context), `auth_sessions`, `calendar_connections` remain authoritative.
- `network_settings`: one row per user, discovery consent, per-field visibility, optional approximate area, revision and revocable random QR identifier. A QR is a name lookup and request link, never an authentication credential.
- `connections`: unique sorted pair, requester, state, per-side blocks, context and timestamps. Both directions refer to this same record.
- `agent_messages`: sender/recipient user IDs, derived agent IDs, type, correlation ID, typed fields and purpose, status, response, creation/expiry and sender request key.
- `network_events`: owner, title, public URL if supplied, start/end, approximate area, visibility and evidence mode. Attendance is explicitly user-reported, never inferred from calendar contents.
- `network_opportunities`: unique canonical pair, profile/settings/event signature, score, reciprocal reasons, signals, overlap, state and per-side dismissals. At most three current recommendations are shown.
- `network_jobs`: coalesced user/version work. Matching executes in short database transactions; a failed attempt retains work for retry.
- `meetings`: participants, purpose/place, exact versioned options, individual availability consents, individual slot approvals, context revisions, expiry and export state.

## Contracts and authorization

The server derives the sender from the authenticated cookie and optionally checks `X-Sidekick-Account`. No route accepts a sender/agent identity from the client. All mutations use same-origin checks, bounded JSON and strict Zod schemas.

Initial `PROFILE_QUERY` requests specify a nonempty allowlist of `profile`, `goal`, `trip`, `events` plus a short purpose. The dispatcher returns only currently permitted fields; missing/restricted information becomes a question to the owner. The owner can decline or explicitly share a one-time answer. Plain text is data, never an instruction to access memory or tools. Envelopes include sender/recipient identities, represented user, correlation ID, lifecycle status, creation, expiry and result. Meeting proposals use their own strict contract and same identity rules.

Accepted connection and no block are required for agent queries. Discovery uses only explicitly network-visible fields of opted-in people; accepted friends can use friends-visible fields. A QR scan reveals only a display name and identity needed for the handshake. Each request, response read, matching evaluation and meeting action rechecks current permissions. Removing/blocking ends future access, pending proposals and one-time answers. Revocation cannot erase facts a person already saw.

Profile fields are projected by allowlist. Never share account email, private location, raw context, conversation draft, private commitments, calendar names/IDs/contents, raw busy intervals or provider credentials. Availability coordination discloses common candidate slots only after both people permit it for that proposal.

## Triggers and duplicate prevention

Enqueue on confirmed profile/goal/trip changes, discovery or visibility changes, connection acceptance/removal and explicitly shared attendance changes. A single Node timer drains bounded queued work, also after relevant HTTP mutations; startup recovers queued work. This requires the documented always-running single Node deployment and durable disk. It is not push delivery when the application is stopped. The UI refreshes its in-app inbox while open.

Canonical pairs, source signatures, active opportunity reuse and persistent dismissals prevent repeated recommendations. A context change recomputes or invalidates an existing opportunity rather than inserting another notification. Requests have sender-scoped request IDs with payload comparison, expiry and rate limits; repeated approval is idempotent. Profile/settings changes make stale proposals unusable.

## Ranking

First require confirmed profiles, authorized sharing, overlapping future SF dates and no block. Rank complementary hiring/seeking goals and reciprocal collaboration using explicit professional terms in confirmed bio/contribution/goal. Require evidence of value in both directions. Add a small shared-event signal only when both attendances are visible. Store reasons, actual signals, benefits for both people and source revisions. Score is an explainable heuristic, not a calibrated probability. No location, attendance, hiring claim or availability is invented.

## Ordered delivery and acceptance

1. **Foundation:** add settings, connections, identity projection and request persistence. Prove outsiders/unconnected users cannot query, private fields are absent, permission removal applies to old responses, IDs cannot be forged and state survives reopen.
2. **QR:** render a persistent QR, scan a camera/image or paste its link, show name, request and separately accept. Prove scan never autoaccepts, repeat scan does not duplicate, rotation invalidates old QR, removal/block works and login preserves the link.
3. **Collaboration:** submit typed profile queries, display authorized response and ask the owner for restricted/missing context. Prove only recipient can answer, expired/revoked requests cannot be answered, retries are safe and injected instructions have no authority.
4. **Proactive matching:** enqueue and drain updates, render ranked reciprocal opportunities and explicitly shared events. Prove hiring/seeking works, incompatible/no-overlap yields none, opt-out and blocks exclude, changed goals invalidate, shared events respect visibility, repeated jobs do not notify twice and dismiss persists.
5. **Meetings:** request permission to compare availability, derive up to three common slots, obtain both exact-slot approvals, refresh conflicts and export a calendar invitation. Prove one approval cannot confirm, outsiders cannot act, changes/revocation invalidate approvals, stale/failed Google reads fail closed, manual fallback is explicit, busy periods/private commitments block slots and repeated approval/export does not duplicate a meeting.

Each phase receives focused tests and a coherent commit. Browser tests cover both end-to-end journeys with fictional accounts, a labeled event and manual/calendar fixtures, reload persistence, failed requests and narrow-screen reflow.

## Integration and demo boundaries

No new API key is required. QR encoding/decoding is local. Real Google availability reuses current OAuth credentials; provider errors are errors, never empty availability. Missing calendar connections permit explicit manual scheduling windows. The existing onboarding calendar requirement is unchanged.

This version can generate an `.ics` invitation only after both people agree. It does not send email or create Google events: current OAuth lacks write permission and registration email is unverified. UI must say that the calendar file still needs importing. A future live write adapter needs incremental consent, deterministic provider event IDs, timeout reconciliation and cancellation; it must not be simulated.

Demo seeding uses a separate explicitly selected database and fictional `.test` accounts. It never touches the real account or claims real events. Demonstrate: complementary hiring match → approved connection → availability comparison → both approvals → invitation download; QR request → acceptance → profile query → optional owner answer → goal/event update → contextual opportunity.

The QR dependencies are used according to their primary documentation: [node-qrcode](https://github.com/soldair/node-qrcode) and [jsQR](https://github.com/cozmo/jsQR). Camera scanning requires a secure browser context; image and link input remain available.
