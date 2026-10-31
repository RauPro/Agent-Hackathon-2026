---
name: sf-sidekick-mobile-first
description: Build or refine SF Sidekick's mobile web onboarding, opportunity cards, conversation preparation, and daily plan. Use for user-facing flows, layout, interaction states, and responsive UI implementation in this repository.
---

# SF Sidekick mobile first

Help a visitor in SF choose a useful conversation and take the next step from their phone. Keep the interface quiet, compact, and readable while walking between commitments.

Use the [implementation plan](../../../docs/implementation-plan.md) as the product contract. Read sections 3–5 for scope and screens; consult section 2.2 only for the step being implemented. These mobile defaults supplement the plan and yield to explicit user choices or an established design system.

## Shape the flow

- Keep three main destinations: editable profile/goal, best opportunities, and a chronological daily plan. Conversation preparation belongs to an opportunity's detail view.
- Onboarding collects the minimum context for the next operation, then shows an editable interpretation. Reveal optional preferences progressively; distinguish unknown availability from explicitly having no commitments.
- Show at most three initial recommendations. Lead with why the opportunity helps the current goal, a documented person when available, and the next useful action. Keep time, location, registration status, and blocking unknowns easy to scan.
- Give each view one visually primary action. Keep prepare, add to plan, official registration, and dismiss accessible as secondary actions where relevant. Use labels that describe the actual effect.
- Put source links, checked time, coverage, and `live`/`saved`/`demo` status within easy reach. Details may expand, but uncertainty that affects a decision stays visible.
- Present a proposed schedule change as a short before/after list, with accept and keep-plan actions. Adding one event already expresses that choice; avoid a redundant confirmation dialog.

## Keep copy necessary

- Keep visible text that helps the user decide, understand a consequence, provide missing information, or recover from an error. Remove slogans and explanations of obvious interactions, such as "In your own words. No forms."
- Give each instruction once. Avoid repeating the same message across a heading, placeholder, helper text, and footer. Add helper text only when the control would otherwise be ambiguous.

## Design from the narrow screen

- Start at 360–390 CSS px with one column; preserve reflow at 320 px. Widen deliberately for tablet/desktop. Use a day list for the agenda; a calendar grid must earn its complexity.
- Use a small type/spacing scale, a restrained palette with one primary accent, and existing components. Keep body and form text around 16 px or larger. Prefer content and hierarchy over ornamental panels, hero sections, or motion.
- Target touch controls of at least 44 × 44 CSS px with separation between adjacent actions. No required hover, drag, or swipe-only interaction.
- Respect safe-area insets. Sticky navigation or actions must leave enough content padding and remain usable with the software keyboard open. Avoid viewport-height assumptions that crop forms on mobile browsers.
- Use semantic controls with one clear accessible name, visible keyboard focus, and sufficient contrast. Icon-only actions need a nonvisual label, not an extra visible explanation. Avoid duplicate screen-reader announcements. Preserve zoom, reduced motion, and dialog focus management.
- Reuse the planned Next.js/TypeScript/Tailwind stack. Keep interactive client boundaries small; add dependencies only when they simplify a required flow. Open location/directions via a map link for the MVP.

## Make real states usable

- Provide meaningful loading, empty, provider-error, saved-data, and stale-goal states. Preserve user input on recoverable errors; offer a concrete retry or correction.
- Keep a pending action visible and prevent accidental resubmission in the UI; server idempotency remains necessary. Reflect a saved plan only after the server confirms it.
- Display SF times explicitly using `America/Los_Angeles`; do not let the device timezone silently shift the itinerary.
- Keep agenda intention, registration/admission, and reported attendance distinct in copy and badges.

## Check the changed journey

Walk the affected flow in an available browser at 390 px, check overflow at 320 px, and inspect a desktop width. Exercise keyboard navigation, long names, missing data, a failed request, and reload after saving when relevant. Check a real phone's keyboard/safe areas when available; report that limitation when only emulation was used. Capture the relevant screen for visual inspection. Test domain behavior in code; avoid component tests that merely repeat markup.
