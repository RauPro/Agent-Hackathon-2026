import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextConflict,
  ContextStore,
  SessionMissing,
} from "../src/lib/server/store";
import { validContext } from "./fixtures";
import { draftFromContext } from "../src/lib/domain/onboarding-chat";
describe("context persistence and ownership", () => {
  let folder: string;
  let store: ContextStore;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "sidekick-test-"));
    store = new ContextStore(join(folder, "context.sqlite"));
  });
  afterEach(() => {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  });
  const input = (baseRevision = 0) => ({
    context: validContext(),
    baseRevision,
    requestId: crypto.randomUUID(),
  });
  it("isolates browsers and replaces forged session cookies", async () => {
    const a = await store.ensureSession();
    const b = await store.ensureSession();
    await store.save(a.token, input());
    expect((await store.read(b.token))?.context).toBeNull();
    expect((await store.read(a.token))?.context?.profile.name).toBe(
      "Alex Rivera",
    );
    expect((await store.ensureSession("a".repeat(64))).token).not.toBe(
      "a".repeat(64),
    );
    await expect(store.save(undefined, input())).rejects.toThrow(
      SessionMissing,
    );
  });
  it("survives closing and reopening SQLite", async () => {
    const session = await store.ensureSession();
    const saved = await store.save(session.token, input());
    store.close();
    store = new ContextStore(join(folder, "context.sqlite"));
    expect(await store.read(session.token)).toEqual(saved);
    expect(saved.evidenceKind).toBe("user_report");
  });
  it("restores a conversation draft after a server restart without confirming it", async () => {
    const session = await store.ensureSession();
    const chat = await store.commitChat(
      session.token,
      {
        action: "message",
        message: "I'm Alex",
        revision: 0,
        requestId: crypto.randomUUID(),
      },
      { reply: "Let's review this.", profileGaps: [], draft: draftFromContext(validContext()) },
    );
    store.close();
    store = new ContextStore(join(folder, "context.sqlite"));
    expect(await store.readChat(session.token)).toEqual(chat);
    expect((await store.read(session.token))?.context).toBeNull();
  });
  it("retries a save once and rejects key reuse with different data", async () => {
    const session = await store.ensureSession();
    const request = input();
    const saved = await store.save(session.token, request);
    expect(await store.save(session.token, request)).toEqual(saved);
    expect((await store.read(session.token))?.revision).toBe(1);
    request.context.goal.type = "hiring";
    await expect(store.save(session.token, request)).rejects.toThrow(
      ContextConflict,
    );
  });
  it("increments revisions for changes and rejects stale edits without overwriting", async () => {
    const session = await store.ensureSession();
    await store.save(session.token, input());
    const newer = input(1);
    newer.context.goal = {
      type: "hiring",
      text: "Find a founding engineer for my agent team.",
    };
    expect((await store.save(session.token, newer)).revision).toBe(2);
    await expect(store.save(session.token, input(1))).rejects.toThrow(
      ContextConflict,
    );
    expect((await store.read(session.token))?.context?.goal.type).toBe(
      "hiring",
    );
  });
  it("preserves the original result of an old retry without undoing a later change", async () => {
    const session = await store.ensureSession();
    const first = input();
    await store.save(session.token, first);
    const second = input(1);
    second.context.profile.name = "Alex updated";
    await store.save(session.token, second);
    expect((await store.save(session.token, first)).revision).toBe(1);
    expect((await store.read(session.token))?.context?.profile.name).toBe(
      "Alex updated",
    );
  });
  it("does not add a revision for an unchanged confirmation", async () => {
    const session = await store.ensureSession();
    await store.save(session.token, input());
    expect((await store.save(session.token, input(1))).revision).toBe(1);
  });
});
