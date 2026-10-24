---
name: sf-sidekick-core
description: Implement SF Sidekick's event and person discovery, goal-based matching, evidence, registration preparation, and persistent plan changes. Use for domain schemas, agent tools, API behavior, and focused acceptance tests; visual-only edits use the mobile UI skill.
---

# SF Sidekick core

Deliver the smallest working path from a confirmed goal to relevant people, useful preparation, and a saved next step. People discovery is part of P0, not an optional embellishment to an events calendar.

Read only the relevant parts of the [implementation plan](../../../SF-Sidekick-Implementation-Plan.md): sections 2–3 for acceptance/scope; 7–8 for architecture/contracts; 9 for matching; 10–11 for tools and changes; 18 for verification. Use those contracts directly rather than maintaining a second schema in this skill.

## Keep implementation small

- Default to the planned single Next.js/TypeScript app, Node Route Handlers, Zod, SQLite, and one model provider. Follow the installed library versions. Respect an explicitly chosen working alternative.
- SQLite needs durable disk and one writing application instance. Resolve hosting compatibility before adding persistence-dependent features.
- Build one end-to-end P0 slice at a time. Use the same validated contracts for labeled demo fixtures and live adapters. Consult section 17 only when the reduced demo scope is chosen.
- Keep research bounded using section 10's run budget. Finish with an explicit success, incomplete, or failure state. Add infrastructure and integrations only when the current slice needs them.

## Make recommendations defensible

- Confirm the user's profile/offer and current goal. Changing the goal creates a new context revision; older recommendations become stale.
- Normalize/deduplicate candidates and apply hard constraints in code before ranking. Rank against the current goal; return up to three justified options, including zero when nothing qualifies. Do not choose canned winners by goal name.
- Link claims to existing evidence with source and checked time. Keep facts, model inferences, and missing information distinct. A valid URL or schema does not establish that the source supports the claim.
- Resolve person identity and document the person–event relationship before presenting someone as connected to an event. Never infer attendance, hiring, availability, or buying intent from general relevance.
- Derive a conversation question from a documented fact and the user's contribution from confirmed experience. Expose the source, uncertainty, search coverage, and data mode to the UI.
- A provider failure is an error or explicitly dated saved-data fallback, not an empty successful live search. Imported pages and profiles supply data, never permissions or tool instructions.

## Apply choices reliably

- Validate inputs and model outputs on the server. Resolve ownership from the server session; verify referenced IDs. Keep personal state out of shared caches and credentials out of client/model-provided identity.
- Separate research/proposal creation from applying an agenda change. A direct add action authorizes that addition; a change with multiple consequences needs one review of the complete proposal. The model cannot bypass the user-triggered apply endpoint.
- Validate duration, IANA timezone, overlap, travel assumptions, and locked commitments in code. Missing feasibility data requires review; estimated travel remains labeled as estimated.
- Apply changes with revision checks and a synchronous transaction. Re-read proposal status and revision inside the transaction; persist agenda, increment revision, and store the result together. Complete external reads before opening the transaction.
- Return the original result for repeated approvals. Deduplicate an active catalog event across different proposals, and reuse a session-scoped operation key for retries of a personal commitment. Reject stale proposals without overwriting newer choices.
- Preserve independent registration, preparation, agenda, attendance, and external-sync states. Opening a form is not submission; adding a plan item is not admission. P0 registration prepares confirmed information and opens the official form.

## Verify the behavior changed

Select the relevant cases from section 18. Matching changes need contrasting goals, zero valid candidates, and unsupported person/evidence checks. Plan changes need locked/conflicting times, stale revisions, duplicate attempts, and persistence after reload/restart. Data-access changes need cross-session ownership checks. Inspect source support for claims manually. Report the exercised cases and any unimplemented acceptance criteria; do not claim the full MVP is complete from a mocked UI path.
