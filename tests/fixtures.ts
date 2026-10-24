import { emptyContext, type UserContext } from "../src/lib/domain/context";

export function validContext(): UserContext {
  return {
    ...emptyContext(),
    profile: { name: "Alex Rivera", bio: "Ingeniero de producto con experiencia construyendo agentes en producción.", offers: "Puedo aportar experiencia en TypeScript, producto y equipos pequeños." },
    goal: { type: "seeking_role", text: "Conocer equipos que busquen un founding engineer para productos de agentes." },
    trip: { city: "San Francisco", start: "2026-10-24", end: "2026-11-05", timezone: "America/Los_Angeles" },
  };
}
