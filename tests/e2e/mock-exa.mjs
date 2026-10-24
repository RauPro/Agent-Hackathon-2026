// Loopback-only synthetic Exa fixture. Never forwards or fetches any URL.
import { createServer } from "node:http";
import { fixtureEvent } from "./discovery-fixtures.mjs";

let scenario = "ready",
  delayMs = 700;
let stats = { search: 0, contents: 0, invalidKeys: 0 };
const server = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/health") return response.end("{}");
  if (request.url === "/stats")
    return response.end(JSON.stringify({ ...stats, scenario }));
  let data = "";
  for await (const chunk of request) data += chunk;
  const body = data ? JSON.parse(data) : {};
  if (request.url === "/scenario") {
    scenario = body.scenario ?? "ready";
    delayMs = body.delayMs ?? 700;
    if (body.reset !== false)
      stats = { search: 0, contents: 0, invalidKeys: 0 };
    return response.end("{}");
  }
  if (!["/search", "/contents"].includes(request.url)) {
    response.writeHead(404);
    return response.end("{}");
  }
  if (request.headers["x-api-key"] !== "test-exa-not-a-secret") {
    stats.invalidKeys++;
    response.writeHead(401);
    return response.end("{}");
  }
  stats[request.url.slice(1)]++;
  const currentScenario = scenario;
  const domains = body.includeDomains ?? [];
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (
    currentScenario === "failed" ||
    (currentScenario === "partial" && domains.includes("partiful.com"))
  ) {
    response.writeHead(503, { "Retry-After": "0" });
    return response.end("{}");
  }
  const lab = fixtureEvent("lab", currentScenario === "past"),
    demo = fixtureEvent("demo", currentScenario === "past");
  const rows = [
    {
      id: "https://luma.com/fixture-lab",
      url: "https://luma.com/fixture-lab",
      title: lab.title,
      text: lab.text,
    },
    {
      id: "https://eventbrite.com/e/fixture-demo-123456789",
      url: "https://eventbrite.com/e/fixture-demo-123456789",
      title: demo.title,
      text: demo.text,
    },
    {
      id: "https://partiful.com/e/fixture-demo",
      url: "https://partiful.com/e/fixture-demo",
      title: demo.title,
      text: `${demo.text}\nRSVP on Eventbrite`,
    },
  ];
  if (request.url === "/contents") {
    const results = rows.filter((r) => body.urls.includes(r.url));
    return response.end(
      JSON.stringify({
        results,
        statuses: body.urls.map((id) => ({
          id,
          status: results.some((r) => r.url === id) ? "success" : "error",
          source: "cached",
        })),
      }),
    );
  }
  const selected = domains.includes("luma.com")
    ? rows[0]
    : domains.includes("eventbrite.com")
      ? rows[1]
      : domains.includes("partiful.com")
        ? rows[2]
        : null;
  response.end(JSON.stringify({ results: selected ? [selected] : [] }));
});
server.listen(Number(process.env.MOCK_EXA_PORT ?? 3103), "127.0.0.1");
