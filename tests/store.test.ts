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

  it("isolates browsers and replaces forged session cookies", () => {
    const a = store.ensureSession();
    const b = store.ensureSession();
    store.save(a.token, input());
    expect(store.read(b.token)?.context).toBeNull();
    expect(store.read(a.token)?.context?.profile.name).toBe("Alex Rivera");
    expect(store.ensureSession("a".repeat(64)).token).not.toBe("a".repeat(64));
    expect(() => store.save(undefined, input())).toThrow(SessionMissing);
  });

  it("survives closing and reopening SQLite", () => {
    const session = store.ensureSession();
    const saved = store.save(session.token, input());
    store.close();
    store = new ContextStore(join(folder, "context.sqlite"));
    expect(store.read(session.token)).toEqual(saved);
    expect(saved.evidenceKind).toBe("user_report");
  });

  it("restores a conversation draft after a server restart without confirming it", () => {
    const session = store.ensureSession();
    const chat = store.commitChat(
      session.token,
      {
        action: "message",
        message: "I'm Alex",
        revision: 0,
        requestId: crypto.randomUUID(),
      },
      { reply: "Let's review this.", draft: draftFromContext(validContext()) },
    );
    store.close();
    store = new ContextStore(join(folder, "context.sqlite"));
    expect(store.readChat(session.token)).toEqual(chat);
    expect(store.read(session.token)?.context).toBeNull();
  });

  it("retries a save once and rejects key reuse with different data", () => {
    const session = store.ensureSession();
    const request = input();
    const saved = store.save(session.token, request);
    expect(store.save(session.token, request)).toEqual(saved);
    expect(store.read(session.token)?.revision).toBe(1);
    request.context.goal.type = "hiring";
    expect(() => store.save(session.token, request)).toThrow(ContextConflict);
  });

  it("increments revisions for changes and rejects stale edits without overwriting", () => {
    const session = store.ensureSession();
    store.save(session.token, input());
    const newer = input(1);
    newer.context.goal = {
      type: "hiring",
      text: "Find a founding engineer for my agent team.",
    };
    expect(store.save(session.token, newer).revision).toBe(2);
    expect(() => store.save(session.token, input(1))).toThrow(ContextConflict);
    expect(store.read(session.token)?.context?.goal.type).toBe("hiring");
  });

  it("preserves the original result of an old retry without undoing a later change", () => {
    const session = store.ensureSession();
    const first = input();
    store.save(session.token, first);
    const second = input(1);
    second.context.profile.name = "Alex updated";
    store.save(session.token, second);
    expect(store.save(session.token, first).revision).toBe(1);
    expect(store.read(session.token)?.context?.profile.name).toBe(
      "Alex updated",
    );
  });

  it("does not add a revision for an unchanged confirmation", () => {
    const session = store.ensureSession();
    store.save(session.token, input());
    expect(store.save(session.token, input(1)).revision).toBe(1);
  });
});
