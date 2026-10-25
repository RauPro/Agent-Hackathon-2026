# Meeting coordination and organic discovery

The app now starts calendar-backed coordination from an accepted connection. The initiating user's action authorizes their availability check; the other person authorizes sharing their available times. Actual offers, checks, and counterproposals appear in the agent conversation. Neither agent can give the final human approval.

If no common time is available, or a calendar is missing, the main chat asks the owner for a day and time. OpenAI interprets the answer into a preview. A separate action checks those windows against the actual calendar; a preference never overrides a busy appointment. Ambiguous answers retain bounded owner-only conversation context across follow-ups. Raw scheduling replies are not sent to the other agent.

Both people approve the same time and place or online format before a separate invitation action is available. That action requests additional Google permission only when needed and may create a Google Meet conference. Provider failure, pending conference generation, and recovery are distinct states. The tests use simulated Google traffic; no real invitation was sent for this release.

## Verification

- Seven deterministic interpretation-boundary tests cover SF offsets, ambiguity, invalid windows, and rejecting extra model actions.
- Three opt-in live OpenAI checks passed using fictional dates and no accounts: a complete preference, a vague preference requiring clarification, and a follow-up time retaining the previously supplied date.
- Browser verification covers both accounts, shared-event timing, one versus two approvals, manual fallback in the main chat, pending Meet recovery without duplicate insertion, and private stay/discovery controls. See [calendar publishing verification](meeting-calendar-publishing.md).
- Background discovery is exercised without browser polling with 30 existing accounts and a newcomer. See [private stay and matching verification](private-stay-and-background-matching-2026-10-24.md).
- A read-only inspection of the user's two named test profiles found confirmed overlapping trips, an accepted QR connection, four completed agent turns, and a meeting waiting for availability. Both profiles had discovery turned off; the account proposing the meeting had no calendar connected.
- Enabling discovery for the role-seeking test account immediately produced visible proposals for three existing fictional demo profiles. They remain unaccepted. This verifies a real recommendation result, not an external employment or hiring outcome.

## Limits

Venue assistance opens a Maps search using an owner-provided area. It does not claim verified venue hours, seating, travel time, or a reservation. Hotel details remain private; sharing an area for a particular meeting is an explicit choice.

Calendar cancellation and changes after publishing are managed in Google Calendar. Sidekick retains the organizer's event link if a proposal later becomes stale; it never labels that state as an external cancellation.
