# Approved meeting publishing

Meeting coordination and publishing are separate actions. Both participants must approve the same current time and meeting format before a person can send the calendar invitation.

## Google access

The existing onboarding connection remains read-only. The explicit meeting publication flow requests `calendar.events.owned` incrementally, after both approvals. Denying the new grant or selecting a different Google identity leaves the existing connection intact. The callback returns to the relevant agent conversation; it does not send an invitation automatically.

The publisher uses the connected account's primary calendar. Participant emails come from Sidekick accounts, not model output or client-supplied invitees. `sendUpdates=all` sends Google's invitation. Online meetings request a new Google Meet conference; in-person meetings retain the approved location.

## Recovery

- A stable event ID and conference request ID belong to each Sidekick meeting.
- Before insertion, the adapter reads that event ID. An uncertain insertion is reconciled before any retry.
- A pending conference is shown as pending, with no invented video link. A later explicit retry reads the same event.
- A Google conference failure can leave an actual calendar invitation without a Meet link. The app reports that distinction and links to the event.
- A cancelled or changed Google event is not silently recreated or overwritten.
- Calendar identifiers stay server-side. Participants receive only the event link, Meet link, and publication state.

## Verification

`tests/meeting-calendar.test.ts` uses an isolated database and mocked Google responses. It checks the two-approval boundary, revocation, incremental OAuth, selection preservation, Google identity changes, attendee resolution, stable IDs, timeout reconciliation, pending conference data, and provider failures. `tests/calendar.test.ts` covers the existing read-only connection and busy-time behavior.

No real Google invitations are sent by these tests. A live publication still needs the organizer's explicit additional Google permission.

Browser verification on October 24, 2026 passed the full 54-test suite, followed by the added private-stay/discovery case. `tests/e2e/meeting-coordination.spec.ts` exercises the actual application routes and UI with loopback-only Google and OpenAI fixtures:

- A shared workshop ends at 11 AM; Google busy time extends to 11:30 AM. The agents propose 11:30 AM using the other person's explicit manual preference from the main chat.
- One time approval cannot export or publish. Both approvals unlock publication. New Google permission alone does not send an invitation.
- A pending Meet request becomes a usable link after a read-only reconciliation; the fixture records exactly one event insertion. Both participants see the same result.
- An entirely busy calendar escalates into the main chat. A typed preferred time remains blocked by that calendar.
- Private hotel details remain visible only in the owner's profile. Nearby-place search uses the area, and unchecked area sharing does not disclose it. Enabling discovery preserves event visibility and does not copy the stay into network settings.

Screenshots were inspected at 320, 390, and 1280 pixels with no horizontal overflow. Local artifacts are in `/private/tmp/sidekick-meeting-coordination/`, including `meeting-google-confirmed-390-simulated.png`, `meeting-no-common-time-390-simulated.png`, and `meeting-private-stay-390-simulated.png`.

## Provider references

- [Google Calendar events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert): event IDs, `sendUpdates`, accepted scopes, and `conferenceDataVersion`.
- [Creating events and conferences](https://developers.google.com/workspace/calendar/api/guides/create-events): conference creation can be asynchronous, and a supplied event ID supports retry reconciliation.
- [Google OAuth incremental authorization](https://developers.google.com/identity/protocols/oauth2): request new permissions when the user invokes the corresponding feature.
