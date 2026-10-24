import { emptyContext, type UserContext } from "../src/lib/domain/context";

export function validContext(): UserContext {
  return {
    ...emptyContext(),
    profile: {
      name: "Alex Rivera",
      bio: "Product engineer with experience building agents in production.",
      offers:
        "I can offer experience in TypeScript, product work, and small teams.",
    },
    goal: {
      type: "seeking_role",
      text: "Meet teams hiring a founding engineer for agent products.",
    },
    trip: {
      city: "San Francisco",
      start: "2026-10-24",
      end: "2026-11-05",
      timezone: "America/Los_Angeles",
    },
  };
}
