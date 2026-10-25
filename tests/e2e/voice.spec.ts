import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { register } from "./auth-helper";

// Chromium records its synthetic microphone; only the remote transcription is mocked.
test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["microphone"],
});

declare global {
  interface Window {
    voiceTest: { streams: MediaStream[]; bytes: number };
  }
}

test.beforeEach(async ({ page, request }) => {
  await register(request);
  await page.context().addCookies((await request.storageState()).cookies);
  await page.addInitScript(() => {
    window.voiceTest = { streams: [], bytes: 0 };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      window.voiceTest.streams.push(stream);
      return stream;
    };
    const Recorder = window.MediaRecorder;
    window.MediaRecorder = class extends Recorder {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options);
        this.addEventListener("dataavailable", (event) => { window.voiceTest.bytes += event.data.size; });
      }
    };
  });
});

async function record(page: Page) {
  await page.getByRole("button", { name: "Record a voice message" }).click();
  await expect(page.getByRole("button", { name: "Stop recording and transcribe" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.voiceTest.bytes)).toBeGreaterThan(0);
}
async function stopped(page: Page) {
  await expect.poll(() => page.evaluate(() => window.voiceTest.streams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")))).toBe(true);
}
async function screenshot(page: Page, name: string) {
  if (process.env.PREVIEW_DIR) await page.screenshot({ path: join(process.env.PREVIEW_DIR, `${name}.png`), fullPage: true });
}

test("records, appends an editable transcript, persists it, and waits for Send", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Your message", { exact: true });
  await input.fill("My existing draft.");
  await record(page);
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot(page, `voice-recording-${width}`);
  }
  await input.fill("My edited draft.");
  await page.getByRole("button", { name: "Stop recording and transcribe" }).click();
  await expect(input).toHaveValue(/^My edited draft\.\nI'm Alex Rivera/);
  await stopped(page);
  expect((await (await page.request.get("/api/onboarding")).json()).chat.revision).toBe(0);
  await expect(input).toBeFocused();
  await screenshot(page, "voice-transcript-desktop");
  await page.reload();
  await expect(input).toHaveValue(/^My edited draft\.\nI'm Alex Rivera/);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Review profile" })).toBeVisible();
  await expect(page.getByText("Transcript added. Review it before sending.", { exact: true })).toHaveCount(0);
});

test("cancel discards audio and releases the microphone without changing typed text", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Your message", { exact: true }).fill("Keep this draft.");
  let uploads = 0;
  page.on("request", (request) => { if (request.url().endsWith("/transcribe")) uploads++; });
  await record(page);
  await page.getByRole("button", { name: "Discard recording" }).click();
  await stopped(page);
  await expect(page.getByLabel("Your message", { exact: true })).toHaveValue("Keep this draft.");
  expect(uploads).toBe(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});

test("transcription failure keeps audio for retry and preserves the typed draft", async ({ page }) => {
  let attempts = 0;
  const sizes: number[] = [];
  await page.route("**/api/onboarding/transcribe", async (route) => {
    sizes.push(route.request().postDataBuffer()!.byteLength);
    if (++attempts === 1) await route.fulfill({ status: 503, json: { message: "Could not transcribe the recording. Retry or type your message." } });
    else await route.continue();
  });
  await page.goto("/");
  await page.getByLabel("Your message", { exact: true }).fill("Keep my context.");
  await record(page);
  await page.getByRole("button", { name: "Stop recording and transcribe" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not transcribe" })).toBeVisible();
  await stopped(page);
  await expect(page.getByLabel("Your message", { exact: true })).toHaveValue("Keep my context.");
  await page.setViewportSize({ width: 320, height: 844 });
  await screenshot(page, "voice-error-320");
  await page.getByRole("button", { name: "Retry transcription" }).click();
  await expect(page.getByLabel("Your message", { exact: true })).toHaveValue(/^Keep my context\.\nI'm Alex Rivera/);
  expect(sizes).toHaveLength(2);
  expect(sizes[0]).toBe(sizes[1]);
});

test("permission denial and unsupported recording keep text input usable", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("Denied", "NotAllowedError"); }; });
  await page.getByRole("button", { name: "Record a voice message" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Microphone access was denied" })).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(window, "MediaRecorder", { value: undefined, configurable: true }); });
  await page.getByRole("button", { name: "Record a voice message" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Voice recording is unavailable" })).toBeVisible();
  await page.getByLabel("Your message", { exact: true }).fill("I can still type.");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});

test("cancelling during transcription ignores a late response", async ({ page }) => {
  let finish!: () => void;
  let handled!: () => void;
  const done = new Promise<void>((resolve) => { handled = resolve; });
  await page.route("**/api/onboarding/transcribe", async (route) => {
    await new Promise<void>((resolve) => { finish = resolve; });
    await route.fulfill({ json: { text: "This cancelled transcript must not be appended." } }).catch(() => {});
    handled();
  });
  await page.goto("/");
  const input = page.getByLabel("Your message", { exact: true });
  await input.fill("Keep this text.");
  await record(page);
  await page.getByRole("button", { name: "Stop recording and transcribe" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Transcribing your recording" })).toBeVisible();
  await expect.poll(() => !!finish).toBe(true);
  await page.getByRole("button", { name: "Discard recording" }).click();
  finish();
  await done;
  await stopped(page);
  await expect(input).toHaveValue("Keep this text.");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});

test("leaving the page stops recording and does not upload audio", async ({ page }) => {
  await page.goto("/");
  await record(page);
  let uploads = 0;
  page.on("request", (request) => { if (request.url().endsWith("/transcribe")) uploads++; });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await stopped(page);
  await expect(page.getByRole("button", { name: "Record a voice message" })).toBeVisible();
  expect(uploads).toBe(0);
});

test("automatically stops at one minute and blocks oversized transcripts until edited", async ({ page }) => {
  await page.clock.install();
  await page.route("**/api/onboarding/transcribe", (route) => route.fulfill({ json: { text: "x".repeat(3001) } }));
  await page.goto("/");
  await record(page);
  await page.clock.fastForward(60000);
  await expect(page.getByRole("alert").filter({ hasText: "Shorten it to 3,000" })).toBeVisible();
  await stopped(page);
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await page.getByLabel("Your message", { exact: true }).fill("A shorter message.");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});

test("transcription endpoint enforces authentication, origin, account, size, and format", async ({ request, playwright }) => {
  const path = "/api/onboarding/transcribe";
  const headers = { origin: "http://127.0.0.1:3100", "content-type": "audio/webm" };
  const anonymous = await playwright.request.newContext({ baseURL: headers.origin });
  expect((await anonymous.post(path, { headers, data: "audio" })).status()).toBe(401);
  await anonymous.dispose();
  expect((await request.post(path, { headers: { ...headers, origin: "https://untrusted.example" }, data: "audio" })).status()).toBe(403);
  expect((await request.post(path, { headers: { ...headers, "X-Sidekick-Account": "another-account" }, data: "audio" })).status()).toBe(401);
  expect((await request.post(path, { headers: { ...headers, "content-type": "text/plain" }, data: "audio" })).status()).toBe(415);
  expect((await request.post(path, { headers, data: Buffer.alloc(3 * 1024 * 1024 + 1) })).status()).toBe(413);
  expect((await request.post(path, { headers, data: "" })).status()).toBe(400);
});
