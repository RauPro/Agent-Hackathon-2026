// Test-only HTTP fixture, not a runtime fallback or a natural-language parser.
// It exercises the actual SDK, route, SQLite store and browser without API spend.
import { createServer } from "node:http";
const server = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/health") {
    response.end("{}");
    return;
  }
  if (request.url !== "/v1/responses" || request.method !== "POST") {
    response.writeHead(404);
    response.end("{}");
    return;
  }
  let data = "";
  for await (const chunk of request) data += chunk;
  const body = JSON.parse(data);
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
  if (message.includes("I'm Alex")) {
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
              text: JSON.stringify({ reply, draft }),
              annotations: [],
            },
          ],
        },
      ],
    }),
  );
});
server.listen(3101, "127.0.0.1");
