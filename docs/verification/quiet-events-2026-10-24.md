# Quiet event suggestions and reported registrations

This release merges the Exa event pipeline from main with the deployed chat workspace and connected-agent conversations. It adds quiet scheduling, persistent suggestion dismissal and explicit registration reports in the existing event store.

## Checks

- 326 unit/service tests passed; 11 paid-provider evaluations skipped by default.
- 43 browser checks passed with loopback-only OpenAI, Exa and Google fixtures. These cover registration, onboarding, Calendar, connected dialogue, meeting consent, event discovery, registration persistence and audience edits, removal, and persistent dismissal without chat messages.
- Typecheck and lint passed. Event layouts were inspected at 320 and 1280 pixels; browser reflow checks also cover 390 pixels.
- One real Exa/OpenAI pipeline completed with `ready` in 17.799 seconds. Four searches and one enrichment request succeeded; one planner, two extraction batches and one ranker succeeded. Forty search results produced sixteen inspected candidates, three validated events and two ranked recommendations. Both recommendations retained uncertain-year and unstated-timezone caveats. This proves provider execution and persistence, not confirmed scheduling eligibility or comprehensive source coverage.
- The live evaluation used a fictional profile and disposable local database. No external registration, real calendar action or real-user contact occurred. Raw provider responses and credentials are excluded from this report.

## Behavioral acceptance

- Each scheduled invocation checks up to twenty due profiles, starts at most one paid pipeline, and respects a bounded deadline. Automatic source refresh is limited to every six hours and uses the existing spend caps.
- A suggestion has a six-hour cooldown, a two-per-day cap and quiet hours. Canonical event/date keys retain dismissal across reordered and cross-listed results. Polling saved state never appends periodic chat messages or starts paid searches.
- A registration requires an explicit user action and exact owned discovery snapshot. It persists self-reported status, report time, event identity, uncertainty and audience; retries do not duplicate records.
- Global and per-event sharing restrictions both apply. Private events do not reach other agents. Trusted cross-platform aliases allow same-event proposals; matching never infers event identity from a title alone.
- Same-event discovery creates only proposals before acceptance. Agent conversation still requires an accepted connection and confirmed, appropriately shared profiles.

External registration remains on the event provider's site. Sidekick records what the user reports; it does not verify admission. Uncertain dates and unknown times cannot establish calendar availability or a confirmed shared-event date.
