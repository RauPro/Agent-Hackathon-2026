# Private stay and background people discovery

## Onboarding

The assistant asks once for a hotel or neighborhood after the required profile details are ready. The answer is optional: unknown, undecided, and declined stays do not block confirmation. Existing profiles without a `stay` field still load. Confirmed stay details appear only in the owner's profile as **Stay · private**.

`tests/context.test.ts` and `tests/onboarding-chat.test.ts` verify bounds, legacy profiles, confirmation, persistence, and suppression of repeated stay questions. `tests/stay-privacy.test.ts` verifies that hotel and private area never enter network projections, typed profile responses, or either participant's agent-model context, even when trip sharing is public to the network.

The live OpenAI check used a fictional Alex Rivera profile, without creating an account. It passed three cases: asking the optional question, extracting a fictional hotel and SoMa separately from public profile descriptions, and accepting an undecided answer without asking again. The sanitized provider output is in [the live evidence](onboarding-private-stay-live-2026-10-24.json).

## Background matching

Confirmation, sharing changes, event changes, and accepted connections retain their existing durable triggers. Fresh triggers take priority over daily checks; the daily sweep preserves pending cursors. Each worker invocation advances at most 80 queue entries and starts no more work after its 20-second deadline. Equal-priority profiles rotate rather than exhausting one person's peers first.

A single pair-check row stores a hash of the two profile revisions, sharing settings, event records, relationship revision, and SF day. It caches both matches and no-match results. Reversed or repeated requests with unchanged inputs skip ranking. Changed inputs and a new SF day invalidate the check. Opportunity reads still enforce current permissions; this cache does not grant sharing permission or begin a conversation before connection acceptance.

`tests/discovery.test.ts` verifies:

- The cron worker handles a new discoverable profile ahead of a 30-person daily backlog, persists one reciprocal opportunity, and starts no agent conversation. No browser request drives the test.
- Fair processing, bounded work, deadline recovery, preserved daily cursors, and independent-client leases.
- Pair deduplication through restart, current-state and new-day invalidation, and atomic rollback on failure.

The 30-person check uses isolated SQLite. It establishes queue behavior, not a production Turso latency guarantee. Remote runs remain deadline-bounded and resume on subsequent cron ticks. The per-user status reports only that user's pending flag and latest check time; it exposes no other user's queue state.

## Verification

- Full unit/service suite: **372 passed, 16 opt-in tests skipped**.
- Repository lint: zero errors or warnings.
- Focused live onboarding: three provider scenarios passed, with credentials kept out of the evidence.

No live deployment, real invitations, or real-user profile changes were performed by these checks.
