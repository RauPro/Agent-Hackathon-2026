// Test-only HTTP fixture, not a runtime fallback or a natural-language parser.
// It exercises the actual SDK, route, SQLite store and browser without API spend.
import { createServer } from "node:http";
import { discoveryDates, fixtureEvent } from "./discovery-fixtures.mjs";
const server = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/health") {
    response.end("{}");
    return;
  }
  if (!["/v1/responses", "/v1/audio/transcriptions"].includes(request.url) || request.method !== "POST") {
    response.writeHead(404);
    response.end("{}");
    return;
  }
  if (request.headers.authorization !== "Bearer test-key-not-a-secret") {
    response.writeHead(401);
    response.end("{}");
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const data = Buffer.concat(chunks);
  if (request.url === "/v1/audio/transcriptions") {
    const form = await new Response(data, { headers: { "Content-Type": request.headers["content-type"] } }).formData();
    const audio = form.get("file");
    if (!(audio instanceof File) || !audio.size || form.get("model") !== "gpt-transcribe") {
      response.writeHead(400);
      response.end(JSON.stringify({ error: { message: "Invalid transcription request fixture" } }));
    } else {
      response.end(JSON.stringify({ text: "I'm Alex Rivera, a product engineer building TypeScript agents in production. I'm in SF from October 24 to November 5, 2026, looking for a founding engineer role on a small team. I can review TypeScript agent evaluation pipelines." }));
    }
    return;
  }
  const body = JSON.parse(data);
  if (body.text?.format?.name === "meeting_time_reply") {
    const input = JSON.parse(body.input[0].content);
    // Named, deterministic test cases only; this is not the product's date parser.
    const clarification = input.message.includes("after lunch");
    const blocked = input.message.includes("11 AM");
    const result = clarification ? { windows: [], clarification: "time" } : {
      windows: [{ date: input.trip.start, start: blocked ? "11:00" : "11:30", end: "13:00" }], clarification: "none",
    };
    response.end(JSON.stringify({ id: "resp_meeting_time_fixture", object: "response", status: "completed", output: [{ id: "msg_meeting_time_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(result), annotations: [] }] }] }));
    return;
  }
  if (body.text?.format?.name === "agent_dialogue_reply") {
    const input = JSON.parse(body.input[0].content);
    const turn = input.turnNumber;
    const dialogue = turn === 1 ? {
      message: "We both build AI agents in production. Would comparing our approaches to reliable deployments be useful?",
      next: "continue",
      questionForUser: null,
      suggestedNextStep: null,
    } : turn === 2 ? {
      message: "Comparing production experience could help both people. I will ask my user which project they would like to discuss.",
      next: "ask_user",
      questionForUser: "Which project would you like to discuss with your connection?",
      suggestedNextStep: null,
    } : turn === 3 ? {
      message: "Thank you for the additional context. A short conversation about reliable AI deployments could be useful to both people.",
      next: "continue",
      questionForUser: null,
      suggestedNextStep: null,
    } : {
      message: "Agreed. Comparing the evaluation pipeline with our deployment experience gives both people a concrete topic to explore.",
      next: "complete",
      questionForUser: null,
      suggestedNextStep: "Consider a short conversation about production AI projects. Both people still need to approve any meeting time.",
    };
    response.end(JSON.stringify({
      id: "resp_dialogue_fixture",
      object: "response",
      status: "completed",
      output: [{
        id: "msg_dialogue_fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(dialogue), annotations: [] }],
      }],
    }));
    return;
  }
  const format = body.text?.format?.name;
  if (format?.startsWith("discovery_")) {
    const input = JSON.parse(body.input[0].content);
    let output;
    if (format === "discovery_plan")
      output = {
        topics: ["typescript", "ai_agents"],
        audiences: [
          input.goal.type === "hiring" ? "builders" : "early_stage_engineers",
        ],
        formats: ["meetup", "workshop"],
        avoid: ["pitch"],
      };
    else if (format === "discovery_extract")
      output = {
        events: input.candidates.map((c) => {
          const fixture = fixtureEvent(
            c.title.includes("Lab") ? "lab" : "demo",
            c.texts.some((t) => t.includes("Past Event")),
          );
          return {
            ...fixture.event,
            candidateId: c.candidateId,
            ...(c.url.includes("partiful")
              ? {
                  registrationPlatform: "eventbrite",
                  registrationLinkQuote: "RSVP on Eventbrite",
                }
              : {}),
          };
        }),
      };
    else if (format === "discovery_rank") {
      const match = input.candidates.find((c) =>
        c.title.includes(input.goal.type === "hiring" ? "Lab" : "Demos"),
      );
      output = {
        picks: match
          ? [
              {
                candidateId: match.id,
                reason:
                  input.goal.type === "hiring"
                    ? "The TypeScript workshop could help you meet engineers working in your stack."
                    : "The early-team demos could help you explore founding engineering work.",
                evidenceQuote: match.description.split("\n")[0],
                caveat: null,
              },
            ]
          : [],
      };
    } else {
      response.writeHead(400);
      response.end("{}");
      return;
    }
    response.end(
      JSON.stringify({
        id: "resp_discovery_fixture",
        object: "response",
        status: "completed",
        output: [
          {
            id: "msg_discovery_fixture",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(output),
                annotations: [],
              },
            ],
          },
        ],
      }),
    );
    return;
  }
  const message = body.input.at(-1).content;
  const draft = JSON.parse(body.input[0].content).currentDraft;
  let reply;
  if (message.includes("FAIL_PROVIDER")) {
    response.writeHead(503);
    response.end(
      JSON.stringify({
        error: { message: "Simulated provider outage", type: "server_error" },
      }),
    );
    return;
  }
  if (message.includes("GENERIC_PROFILE")) {
    Object.assign(draft, {
      name: "Alex Rivera",
      bio: "I am an experienced professional working in the tech industry.",
      offers: "I can help with anything and share my experience.",
      goalType: "collaborators",
      goalText: "I want to meet people and find new opportunities.",
      arrival: "2026-10-24",
      departure: "2026-11-05",
    });
    reply = "Your profile is ready to review.";
  } else if (message.includes("I'm Alex")) {
    Object.assign(draft, {
      name: "Alex Rivera",
      bio: "Product engineer building TypeScript agents in production.",
      offers:
        "Experience building TypeScript agents and working in small product teams.",
      goalType: "seeking_role",
      goalText:
        "Find a founding engineer role with a small team building agents.",
      arrival: "2026-10-24",
      departure: "2026-11-05",
    });
    if (message.includes("DISCOVERY_PROFILE")) {
      const dates = discoveryDates();
      draft.arrival = dates.start;
      draft.departure = dates.end;
    }
    reply =
      "I've put together a first profile from what you told me. Review it when you're ready, or tell me what to change.";
  } else if (message.includes("Actually, I'm hiring")) {
    draft.goalType = "hiring";
    draft.goalText = "Hire a founding engineer for my agent startup.";
    reply =
      "Got it — you're hiring, rather than looking for a role. I've updated your draft for review.";
  } else if (message.includes("No commitments")) {
    draft.commitments = { status: "none", items: [] };
    reply = "No additional commitments noted. Your profile is ready to review.";
  } else if (message.includes("I leave before I arrive")) {
    draft.departure = "2026-10-01";
    reply =
      "That departure is before your arrival. What is your departure date?";
  } else {
    reply = "What would you like to get out of your time in SF?";
  }
  response.end(
    JSON.stringify({
      id: "resp_fixture",
      object: "response",
      status: "completed",
      output: [
        {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({ reply, draft, profileGaps: [] }),
              annotations: [],
            },
          ],
        },
      ],
    }),
  );
});
server.listen(Number(process.env.MOCK_OPENAI_PORT ?? 3101), "127.0.0.1");
