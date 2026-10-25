import SQLite from "better-sqlite3";
import { createClient as createLocalLibsqlClient } from "@libsql/client";
import * as remoteLibsql from "@libsql/client/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncDatabase } from "@/lib/server/database";
import { ContextStore } from "@/lib/server/store";

vi.mock("@libsql/client/web", () => ({ createClient: vi.fn() }));

const directories: string[] = [];
const connections: { close(): void }[] = [];
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "sidekick-database-"));
  directories.push(directory);
  return join(directory, "test.sqlite");
}
function database(path = ":memory:") {
  const db = new AsyncDatabase(path);
  connections.push(db);
  return db;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const db of connections.splice(0)) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("async persistence", () => {
  it("serializes two local clients and outside reads while a transaction awaits", async () => {
    const path = databasePath();
    const first = database(path),
      second = database(path);
    await first
      .prepare("INSERT INTO app_meta (key,value) VALUES ('counter','0')")
      .run();
    const entered = gate(),
      finish = gate();
    const a = first
      .transaction(async () => {
        await first
          .prepare("UPDATE app_meta SET value='1' WHERE key='counter'")
          .run();
        entered.release();
        await finish.promise;
      })
      .immediate();
    await entered.promise;
    const b = second
      .transaction(async () => {
        const row = await second
          .prepare("SELECT value FROM app_meta WHERE key='counter'")
          .get();
        await second
          .prepare("UPDATE app_meta SET value=? WHERE key='counter'")
          .run(String(Number(row?.value) + 1));
      })
      .immediate();
    const outside = first
      .prepare("SELECT value FROM app_meta WHERE key='counter'")
      .get();
    finish.release();
    await Promise.all([a, b, outside]);
    expect(
      await first
        .prepare("SELECT value FROM app_meta WHERE key='counter'")
        .get(),
    ).toEqual({ value: "2" });
    expect(await outside).toEqual({ value: "1" });
  });

  it("rolls back failed nested work without committing or poisoning its outer transaction", async () => {
    const db = database();
    await db
      .transaction(async () => {
        await db
          .prepare("INSERT INTO app_meta (key,value) VALUES ('outer','kept')")
          .run();
        await expect(
          db
            .transaction(async () => {
              await db
                .prepare(
                  "INSERT INTO app_meta (key,value) VALUES ('inner','removed')",
                )
                .run();
              throw new Error("nested failure");
            })
            .immediate(),
        ).rejects.toThrow("nested failure");
        await db
          .transaction(async () => {
            await db
              .prepare(
                "INSERT INTO app_meta (key,value) VALUES ('nested-success','kept')",
              )
              .run();
          })
          .immediate();
      })
      .immediate();
    expect(
      await db
        .prepare(
          "SELECT key FROM app_meta WHERE key != 'database_purpose' ORDER BY key",
        )
        .all(),
    ).toEqual([{ key: "nested-success" }, { key: "outer" }]);
    await expect(
      db
        .transaction(async () => {
          await db.prepare("DELETE FROM app_meta WHERE key='outer'").run();
          throw new Error("outer failure");
        })
        .immediate(),
    ).rejects.toThrow("outer failure");
    expect(
      await db.prepare("SELECT value FROM app_meta WHERE key='outer'").get(),
    ).toEqual({ value: "kept" });
  });

  it("atomically leases across clients and prevents an expired owner from releasing a new lease", async () => {
    const path = databasePath(),
      first = database(path),
      second = database(path);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const results = await Promise.all([
      first.acquireLease("chat:user", 100),
      second.acquireLease("chat:user", 100),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const original = results.find(Boolean)!;
    clock.mockReturnValue(1101);
    const replacement = await second.acquireLease("chat:user", 100);
    expect(replacement).toBeTruthy();
    await first.releaseLease("chat:user", original);
    expect(await first.acquireLease("chat:user", 100)).toBeNull();
    await second.releaseLease("chat:user", replacement!);
    expect(await first.acquireLease("chat:user", 100)).toBeTruthy();
  });

  it("adds missing columns without deleting an existing account or profile", async () => {
    const path = databasePath();
    const legacy = new SQLite(path);
    legacy.exec(`CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, context_json TEXT, confirmed_at TEXT, created_at TEXT NOT NULL);
      INSERT INTO sessions (token_hash,created_at) VALUES ('profile','2026-10-24');
      CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,email_verified_at TEXT,profile_id TEXT UNIQUE NOT NULL REFERENCES sessions(token_hash),created_at TEXT NOT NULL);
      INSERT INTO users (id,email,password_hash,profile_id,created_at) VALUES ('user','test@example.test','hash','profile','2026-10-24');
      CREATE TABLE calendar_oauth_states (state_hash TEXT PRIMARY KEY,session_id TEXT NOT NULL,encrypted_verifier TEXT NOT NULL,expires_at INTEGER NOT NULL,base_revision INTEGER NOT NULL);
      CREATE TABLE network_connections (user_a TEXT,user_b TEXT,requester_id TEXT,status TEXT,context TEXT,source TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(user_a,user_b));
      CREATE TABLE network_jobs (user_id TEXT PRIMARY KEY,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO network_jobs VALUES ('user',7,'2026-10-24');`);
    legacy.close();
    const db = database(path);
    expect(
      await db.prepare("SELECT email,profile_id FROM users").get(),
    ).toEqual({ email: "test@example.test", profile_id: "profile" });
    expect(
      await db.prepare("SELECT version,cursor,priority FROM network_jobs").get(),
    ).toEqual({ version: 7, cursor: "", priority: 1 });
    expect(
      (await db.prepare("PRAGMA table_info(calendar_oauth_states)").all()).some(
        (row) => row.name === "browser_token_hash",
      ),
    ).toBe(true);
    expect(
      (await db.prepare("PRAGMA table_info(network_connections)").all()).some(
        (row) => row.name === "revision",
      ),
    ).toBe(true);
  });

  it("initializes the same chat safely in simultaneous requests", async () => {
    const store = new ContextStore(databasePath());
    connections.push(store);
    const { token } = await store.ensureSession();
    const chats = await Promise.all([
      store.readChat(token),
      store.readChat(token),
    ]);
    expect(chats[0]).toEqual(chats[1]);
    expect(
      await store.db
        .prepare("SELECT COUNT(*) AS count FROM onboarding_chats")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("rejects ephemeral local persistence on Vercel", () => {
    vi.stubEnv("VERCEL", "1");
    expect(() => new AsyncDatabase(":memory:")).toThrow("Vercel requires");
  });

  it("does not reuse a database marked for the other environment", async () => {
    // A second connection must check the persisted marker on its own initialization.
    const path = databasePath();
    const first = database(path);
    await first
      .prepare("UPDATE app_meta SET value='demo' WHERE key='database_purpose'")
      .run();
    const second = database(path);
    await expect(second.prepare("SELECT 1").get()).rejects.toThrow(
      "database purpose",
    );
  });

  it("routes remote-client transactions through libSQL and preserves nested rollback", async () => {
    // Exercise the remote adapter with the actual libSQL transaction API backed
    // by a disposable local database. This is not a live Turso connectivity test.
    const client = createLocalLibsqlClient({ url: `file:${databasePath()}` });
    vi.mocked(remoteLibsql.createClient).mockReturnValue(client);
    const db = new AsyncDatabase({
      url: "https://fixture.example.test",
      authToken: "fixture",
      purpose: "production",
    });
    connections.push(db);
    await db
      .transaction(async () => {
        await db
          .prepare("INSERT INTO app_meta (key,value) VALUES (?,?)")
          .run("saved", "yes");
        await expect(
          db
            .transaction(async () => {
              await db
                .prepare("INSERT INTO app_meta (key,value) VALUES (?,?)")
                .run("discarded", "yes");
              throw new Error("discard nested changes");
            })
            .immediate(),
        ).rejects.toThrow("discard nested changes");
      })
      .immediate();
    expect(
      await db.prepare("SELECT value FROM app_meta WHERE key=?").get("saved"),
    ).toEqual({ value: "yes" });
    expect(
      await db
        .prepare("SELECT value FROM app_meta WHERE key=?")
        .get("discarded"),
    ).toBeUndefined();
    expect(await db.acquireLease("remote-lease", 1000)).toBeTruthy();
    expect(await db.acquireLease("remote-lease", 1000)).toBeNull();
    await expect(
      db
        .prepare(
          "INSERT INTO auth_sessions (token_hash,user_id,expires_at) VALUES ('invalid','missing-user',1)",
        )
        .run(),
    ).rejects.toThrow(/foreign key/i);
  });
});
