import { randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";

// Fictional accounts only. The server must explicitly use an isolated demo database.
const origin = new URL(process.env.DEMO_ORIGIN || "http://127.0.0.1:3001");
if (
  origin.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(origin.hostname)
)
  throw new Error("Use a local demo server.");
const mode = await fetch(new URL("/api/network/demo", origin)).then(
  (response) => response.json(),
);
if (!mode.enabled)
  throw new Error(
    "Start Sidekick with SIDEKICK_DEMO=1 and a DATABASE_PATH ending in .demo.sqlite before seeding.",
  );
const today = Temporal.Now.plainDateISO("America/Los_Angeles");
let day = today.add({ days: 2 });
while (day.dayOfWeek > 5) day = day.add({ days: 1 });
const start = day.toString(),
  end = day.add({ days: 14 }).toString();
const at = (time) =>
  day
    .toZonedDateTime({ timeZone: "America/Los_Angeles", plainTime: time })
    .toInstant()
    .toString();
const people = [
  {
    name: "Raul Demo",
    email: "raul@sidekick.example.test",
    goal: "seeking_role",
    text: "Find a founding engineer role working on AI agents and infrastructure.",
    bio: "Software engineer building AI agents in production, with ICPC and competitive programming experience.",
    offers:
      "AI agent engineering, algorithms, TypeScript and production infrastructure.",
  },
  {
    name: "Agustin Demo",
    email: "agustin@sidekick.example.test",
    goal: "hiring",
    text: "Hire a founding engineer with AI agent and infrastructure experience.",
    bio: "Founder building AI agents and infrastructure for an early-stage startup.",
    offers:
      "A founding engineer role with ownership of AI agent infrastructure and product development.",
  },
  {
    name: "Pedro Demo",
    email: "pedro@sidekick.example.test",
    goal: "collaborators",
    text: "Explore algorithms and AI infrastructure with other builders.",
    bio: "Founder working on algorithms, ICPC problems and AI infrastructure for optimization.",
    offers:
      "Competitive programming and optimization experience, AI infrastructure and startup opportunities.",
  },
];
const clients = new Map();
for (const person of people) {
  let cookie = "";
  const call = async (path, data) => {
    const response = await fetch(new URL(path, origin), {
      method: data ? "POST" : "GET",
      headers: {
        origin: origin.origin,
        ...(cookie ? { cookie } : {}),
        ...(data ? { "Content-Type": "application/json" } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie").split(";")[0];
    const body = await response.json();
    if (!response.ok)
      throw new Error(`${path}: ${body.message || response.status}`);
    return body;
  };
  const { devCode } = await call("/api/auth", {
    action: "request_code",
    email: person.email,
  });
  await call("/api/auth", {
    action: "verify",
    email: person.email,
    code: devCode,
  });
  const state = await call("/api/state");
  await call("/api/context", {
    confirmed: true,
    baseRevision: state.revision,
    requestId: randomUUID(),
    context: {
      profile: { name: person.name, bio: person.bio, offers: person.offers },
      goal: { type: person.goal, text: person.text },
      trip: {
        city: "San Francisco",
        timezone: "America/Los_Angeles",
        start,
        end,
      },
      availability: { status: "unknown", windows: [] },
      commitments: { status: "none", items: [] },
      preferences: { meetingFormat: "one_to_one", budgetUsd: null },
    },
  });
  const network = await call("/api/network");
  clients.set(person.name, {
    call,
    accountId: network.accountId,
    qrToken: network.settings.qrToken,
  });
  await call("/api/network", {
    action: "settings",
    settings: {
      revision: network.settings.revision,
      discoverable: true,
      visibility: {
        profile: "network",
        goal: "network",
        trip: "network",
        events: "friends",
      },
      area: "Downtown SF",
    },
  });
  const existing = network.events.find(
    (event) => event.title === "Demo: AI builders meetup",
  );
  await call("/api/network", {
    action: "event",
    event: {
      ...(existing ? { id: existing.id } : {}),
      title: "Demo: AI builders meetup",
      url: "https://example.test/sidekick-demo-meetup",
      start: at("15:00"),
      end: at("16:00"),
      area: "Marina District",
      visibility: "friends",
    },
  });
  console.log(`${person.name}: ${person.email}`);
}
// Optional replayable conversation fixture, using the same human-approved APIs.
// Only fictional accounts in the explicitly isolated demo can reach this block.
if (process.env.DEMO_CONVERSATION === "1") {
  const raul = clients.get("Raul Demo"),
    pedro = clients.get("Pedro Demo");
  await raul.call("/api/network", {
    action: "connect",
    toUserId: pedro.accountId,
    source: "qr",
    token: pedro.qrToken,
    context: "Demo: met at the AI builders meetup.",
  });
  await pedro.call("/api/network", {
    action: "connection",
    toUserId: raul.accountId,
    decision: "accept",
  });
  await pedro.call("/api/network", {
    action: "query",
    toUserId: raul.accountId,
    requestId: "1a467a4d-f4b7-4d76-a2ba-312ad86d6304",
    fields: ["profile", "goal"],
    purpose:
      "Pedro is exploring an optimization startup. Does Raul have algorithms experience, and is he open to an early-stage technical role?",
  });
  console.log(
    `Agent conversation: ${new URL(`/network?view=agents&person=${pedro.accountId}`, origin)}`,
  );
}
console.log(
  `\nOpen ${new URL("/login?next=%2Fnetwork", origin)} in separate browser profiles and continue with a demo email above.`,
);
console.log(
  `SF demo dates: ${start} through ${end}. For manual meeting availability use ${start}, 16:00–18:00.`,
);
console.log(
  "No external event was registered, no email was sent, and no Google calendar was accessed.",
);
