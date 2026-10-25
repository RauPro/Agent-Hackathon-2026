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

## Provider references

- [Google Calendar events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert): event IDs, `sendUpdates`, accepted scopes, and `conferenceDataVersion`.
- [Creating events and conferences](https://developers.google.com/workspace/calendar/api/guides/create-events): conference creation can be asynchronous, and a supplied event ID supports retry reconciliation.
- [Google OAuth incremental authorization](https://developers.google.com/identity/protocols/oauth2): request new permissions when the user invokes the corresponding feature.
