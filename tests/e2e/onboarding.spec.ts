import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { validContext } from "../fixtures";

const origin = "http://127.0.0.1:3100";
const context = validContext();
const next = (page: Page) =>
  page.getByRole("button", { name: "Continuar" }).click();
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}
async function screenshot(page: Page, name: string) {
  if (process.env.PREVIEW_DIR)
    await page.screenshot({
      path: join(process.env.PREVIEW_DIR, `${name}.png`),
      fullPage: true,
    });
}
async function fillToSchedule(page: Page, name = context.profile.name) {
  await page
    .getByLabel("¿Cómo sería una buena semana para ti?")
    .fill(context.goal.text);
  await next(page);
  await page.getByLabel("¿Cómo te llamas?").fill(name);
  await page
    .getByLabel("Cuéntanos sobre tu experiencia")
    .fill(context.profile.bio);
  await page
    .getByLabel("¿Qué puedes aportar a una conversación?")
    .fill(context.profile.offers);
  await noOverflow(page);
  await next(page);
  await page.getByLabel("Llegada").fill(context.trip.start);
  await page.getByLabel("Salida", { exact: true }).fill(context.trip.end);
}
async function review(page: Page) {
  await next(page);
  await expect(
    page.getByRole("heading", { name: "Tu punto de partida." }),
  ).toBeVisible();
  await noOverflow(page);
}
async function confirm(page: Page) {
  await page
    .getByLabel("Este resumen refleja lo que busco y lo que puedo aportar.")
    .check();
  await page.getByRole("button", { name: "Confirmar y guardar" }).click();
}

test("mobile onboarding validates, saves, reloads, and updates the goal", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "¿Qué quieres conseguir en SF?" }),
  ).toBeVisible();
  await screenshot(page, "onboarding-mobile");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Ir al contenido" }),
  ).toBeFocused();
  await next(page);
  await expect(
    page.getByLabel("¿Cómo sería una buena semana para ti?"),
  ).toBeFocused();
  await expect(
    page.getByRole("alert").filter({ hasText: "Hay información por revisar" }),
  ).toBeVisible();
  await fillToSchedule(page);
  await page.getByLabel("Salida", { exact: true }).fill("2026-10-23");
  await next(page);
  await expect(
    page.getByText("La salida debe ser el mismo día o después de la llegada."),
  ).toBeVisible();
  await page.getByLabel("Salida", { exact: true }).fill(context.trip.end);
  await page
    .getByRole("radio", { name: "Añadir franjas", exact: true })
    .check();
  await page.getByRole("radio", { name: "Añadir", exact: true }).check();
  await page.getByLabel("Nombre del compromiso").fill("Cena con el equipo");
  await noOverflow(page);
  await screenshot(page, "onboarding-schedule-mobile");
  await review(page);
  await page.getByRole("button", { name: "Confirmar y guardar" }).click();
  await expect(
    page.getByText("Confirma el resumen para guardar."),
  ).toBeVisible();
  await confirm(page);
  await expect(page.getByText("Perfil guardado")).toBeVisible();
  await expect(page.getByText("Confirmado por ti · versión 1")).toBeVisible();
  await screenshot(page, "onboarding-saved-mobile");
  await page.reload();
  await expect(
    page.getByText("Cena con el equipo", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Editar mi perfil" }).click();
  await page.getByRole("radio", { name: /Encontrar talento/ }).check();
  await page
    .getByLabel("¿Cómo sería una buena semana para ti?")
    .fill(
      "Encontrar un founding engineer para construir nuestro producto de agentes.",
    );
  await next(page);
  await next(page);
  await review(page);
  await confirm(page);
  await expect(page.getByText("Confirmado por ti · versión 2")).toBeVisible();
  expect(
    (await (await page.request.get("/api/state")).json()).context.goal.type,
  ).toBe("hiring");
});

test("320px and desktop reflow with long names and unknown availability", async ({
  page,
}) => {
  for (const width of [320, 1280]) {
    await page.context().clearCookies();
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "¿Qué quieres conseguir en SF?" }),
    ).toBeVisible();
    await noOverflow(page);
    await screenshot(page, `onboarding-${width}`);
    await fillToSchedule(
      page,
      "Alexandra María de los Ángeles Rivera Fernández del Río",
    );
    await page
      .getByRole("radio", { name: "Añadir franjas", exact: true })
      .check();
    await noOverflow(page);
    await screenshot(page, `onboarding-schedule-${width}`);
    await page
      .getByRole("radio", { name: "Aún no lo sé", exact: true })
      .check();
    await page.getByRole("radio", { name: "No tengo compromisos" }).check();
    await noOverflow(page);
    await review(page);
    await expect(page.getByText("Franjas por definir.")).toBeVisible();
    await expect(
      page.getByText("Has indicado que no tienes compromisos fijos."),
    ).toBeVisible();
    await confirm(page);
    await expect(page.getByText("Perfil guardado")).toBeVisible();
    await noOverflow(page);
    await screenshot(page, `onboarding-saved-${width}`);
  }
});

test("a lost save response preserves input and retries the same operation", async ({
  page,
}) => {
  await page.goto("/");
  await fillToSchedule(page);
  await review(page);
  let loseResponse = true;
  const keys: string[] = [];
  await page.route("**/api/context", async (route) => {
    keys.push(route.request().postDataJSON().requestId);
    if (loseResponse) {
      loseResponse = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    } else await route.continue();
  });
  await confirm(page);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "No pudimos confirmar el guardado" }),
  ).toBeVisible();
  await expect(
    page.getByText(context.profile.offers, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirmar y guardar" }).click();
  await expect(page.getByText("Perfil guardado")).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect((await (await page.request.get("/api/state")).json()).revision).toBe(
    1,
  );
});

test("a stale tab shows the saved version instead of overwriting it", async ({
  page,
}) => {
  await page.goto("/");
  await fillToSchedule(page);
  await review(page);
  const newer = validContext();
  newer.goal = {
    type: "customers",
    text: "Explorar pilotos con dos empresas del sector de la construcción.",
  };
  const response = await page.request.post("/api/context", {
    headers: { origin },
    data: {
      context: newer,
      baseRevision: 0,
      requestId: crypto.randomUUID(),
      confirmed: true,
    },
  });
  expect(response.status()).toBe(200);
  await confirm(page);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Tu perfil cambió en otra pestaña" }),
  ).toBeVisible();
  await expect(
    page.getByText(context.goal.text, { exact: true }),
  ).toBeVisible();
  await page.getByText("Ver la versión guardada", { exact: true }).click();
  await expect(page.getByText(newer.goal.text, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cargar versión guardada" }).click();
  await expect(
    page.getByLabel("¿Cómo sería una buena semana para ti?"),
  ).toHaveValue(newer.goal.text);
  expect((await (await page.request.get("/api/state")).json()).revision).toBe(
    1,
  );
});

test("initial read failure offers a working retry", async ({ page }) => {
  let fail = true;
  await page.route("**/api/state", (route) =>
    fail
      ? route.fulfill({
          status: 503,
          body: "{}",
          contentType: "application/json",
        })
      : route.continue(),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "No pudimos abrir tu espacio." }),
  ).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Volver a intentar" }).click();
  await expect(
    page.getByRole("heading", { name: "¿Qué quieres conseguir en SF?" }),
  ).toBeVisible();
});

test("API enforces origin, confirmation, identity, payload limits, and session isolation", async ({
  request,
  playwright,
}) => {
  const opened = await request.get("/api/state");
  expect(opened.headers()["cache-control"]).toContain("no-store");
  expect(opened.headers()["set-cookie"]).toContain("HttpOnly");
  const body = {
    context,
    baseRevision: 0,
    requestId: crypto.randomUUID(),
    confirmed: true,
  };
  expect(
    (
      await request.post("/api/context", {
        data: body,
        headers: { origin: "https://untrusted.example" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/context", {
        data: { ...body, confirmed: false },
        headers: { origin },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.post("/api/context", {
        data: { ...body, sessionId: "someone-else" },
        headers: { origin },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.post("/api/context", {
        data: "x".repeat(40000),
        headers: { origin, "Content-Type": "application/json" },
      })
    ).status(),
  ).toBe(413);
  expect(
    (
      await request.post("/api/context", { data: body, headers: { origin } })
    ).status(),
  ).toBe(200);
  const second = await playwright.request.newContext({ baseURL: origin });
  expect((await (await second.get("/api/state")).json()).context).toBeNull();
  await second.dispose();
});
