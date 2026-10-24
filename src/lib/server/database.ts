import SQLite from "better-sqlite3";
import {
  createClient,
  type Client,
  type InValue,
  type Transaction,
} from "@libsql/client/web";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { additiveColumns, databaseSchema } from "./database-schema";

export type RemoteDatabaseOptions = {
  url: string;
  authToken: string;
  purpose: "production" | "demo";
};
type Row = Record<string, unknown>;
type Result = {
  rows: Row[];
  changes: number;
  lastInsertRowid: number | bigint;
};
type Executor = {
  execute(sql: string, args?: unknown[]): Promise<Result>;
  exec(sql: string): Promise<void>;
};
type TransactionContext = { executor: Executor; active: boolean };

class Mutex {
  private tail = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

// Two local connections must not synchronously wait on each other's SQLite lock
// while an async transaction is waiting for this same JavaScript event loop.
const localMutexes = new Map<string, Mutex>();
function localMutex(path: string) {
  if (path === ":memory:") return new Mutex();
  const key = realpathSync(resolve(path));
  let mutex = localMutexes.get(key);
  if (!mutex) localMutexes.set(key, (mutex = new Mutex()));
  return mutex;
}

function remoteExecutor(client: Client | Transaction): Executor {
  return {
    async execute(sql, args = []) {
      const result = await client.execute({ sql, args: args as InValue[] });
      return {
        rows: result.rows.map((row) =>
          Object.fromEntries(result.columns.map((name) => [name, row[name]])),
        ),
        changes: result.rowsAffected,
        lastInsertRowid: result.lastInsertRowid ?? 0,
      };
    },
    exec: (sql) => client.executeMultiple(sql),
  };
}

/** One async API for local SQLite and a durable remote libSQL database. */
export class AsyncDatabase {
  private readonly local?: SQLite.Database;
  private readonly remote?: Client;
  private readonly executor: Executor;
  private readonly mutex: Mutex;
  private readonly scope = new AsyncLocalStorage<TransactionContext>();
  private readonly purpose: "production" | "demo";
  private initialized?: Promise<void>;
  private closed = false;

  constructor(source: string | RemoteDatabaseOptions) {
    if (typeof source === "string") {
      if (process.env.VERCEL === "1")
        throw new Error(
          "Vercel requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN. Local SQLite is not durable there.",
        );
      if (source !== ":memory:")
        mkdirSync(dirname(resolve(source)), { recursive: true });
      this.local = new SQLite(source);
      this.local.pragma("journal_mode = WAL");
      this.local.pragma("foreign_keys = ON");
      this.local.pragma("busy_timeout = 5000");
      const local = this.local;
      this.executor = {
        async execute(sql, args = []) {
          const statement = local.prepare(sql);
          if (statement.reader)
            return {
              rows: statement.all(...args) as Row[],
              changes: 0,
              lastInsertRowid: 0,
            };
          const result = statement.run(...args);
          return { rows: [], ...result };
        },
        async exec(sql) {
          local.exec(sql);
        },
      };
      this.purpose = source.endsWith(".demo.sqlite") ? "demo" : "production";
      this.mutex = localMutex(source);
    } else {
      if (!source.url || !source.authToken)
        throw new Error(
          "Remote persistence requires a database URL and authentication token.",
        );
      const url = new URL(source.url);
      if (
        !["libsql:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("Use a secure remote libSQL database URL.");
      this.remote = createClient({
        url: source.url,
        authToken: source.authToken,
        intMode: "number",
      });
      this.executor = remoteExecutor(this.remote);
      this.purpose = source.purpose;
      this.mutex = new Mutex();
    }
  }

  private async begin<T>(work: (executor: Executor) => Promise<T>): Promise<T> {
    if (this.remote) {
      const transaction = await this.remote.transaction("write");
      try {
        const result = await work(remoteExecutor(transaction));
        await transaction.commit();
        return result;
      } catch (error) {
        try {
          await transaction.rollback();
        } catch {
          /* Preserve the original failure. */
        }
        throw error;
      } finally {
        transaction.close();
      }
    }
    await this.executor.exec("BEGIN IMMEDIATE");
    try {
      const result = await work(this.executor);
      await this.executor.exec("COMMIT");
      return result;
    } catch (error) {
      await this.executor.exec("ROLLBACK");
      throw error;
    }
  }

  private ready() {
    if (this.closed) return Promise.reject(new Error("Database is closed."));
    // Lazy initialization has one awaited barrier and never launches background
    // work from a constructor. Schema writes are serialized with other clients.
    return (this.initialized ??= this.mutex.run(() =>
      this.begin(async (executor) => {
        const foreignKeys = await executor.execute("PRAGMA foreign_keys");
        if (foreignKeys.rows[0]?.foreign_keys !== 1)
          throw new Error("Database foreign-key enforcement must be enabled.");
        await executor.exec(databaseSchema);
        for (const column of additiveColumns) {
          const result = await executor.execute(
            `PRAGMA table_info(${column.table})`,
          );
          if (!result.rows.some((row) => row.name === column.name))
            await executor.exec(
              `ALTER TABLE ${column.table} ADD COLUMN ${column.name} ${column.sql}`,
            );
        }
        const existing = await executor.execute(
          "SELECT value FROM app_meta WHERE key = 'database_purpose'",
        );
        if (existing.rows[0] && existing.rows[0].value !== this.purpose)
          throw new Error(
            "The database purpose does not match this deployment. Use separate production and demo databases.",
          );
        await executor.execute(
          "INSERT OR IGNORE INTO app_meta (key, value) VALUES ('database_purpose', ?)",
          [this.purpose],
        );
      }),
    ));
  }

  private async use<T>(work: (executor: Executor) => Promise<T>): Promise<T> {
    const context = this.scope.getStore();
    if (context) {
      if (!context.active)
        throw new Error("The database transaction has finished.");
      return work(context.executor);
    }
    await this.ready();
    return this.mutex.run(() => work(this.executor));
  }

  prepare(sql: string) {
    return {
      get: async (...args: unknown[]) =>
        this.use(
          async (executor) => (await executor.execute(sql, args)).rows[0],
        ),
      all: async (...args: unknown[]) =>
        this.use(async (executor) => (await executor.execute(sql, args)).rows),
      run: async (...args: unknown[]) =>
        this.use(async (executor) => {
          const { changes, lastInsertRowid } = await executor.execute(
            sql,
            args,
          );
          return { changes, lastInsertRowid };
        }),
    };
  }

  async exec(sql: string) {
    await this.use((executor) => executor.exec(sql));
  }

  transaction<T>(work: () => T | Promise<T>) {
    return {
      immediate: async (): Promise<T> => {
        const existing = this.scope.getStore();
        if (existing) {
          if (!existing.active)
            throw new Error("The database transaction has finished.");
          const savepoint = `nested_${randomUUID().replaceAll("-", "")}`;
          await existing.executor.exec(`SAVEPOINT ${savepoint}`);
          try {
            const value = await work();
            await existing.executor.exec(`RELEASE SAVEPOINT ${savepoint}`);
            return value;
          } catch (error) {
            await existing.executor.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await existing.executor.exec(`RELEASE SAVEPOINT ${savepoint}`);
            throw error;
          }
        }
        await this.ready();
        return this.mutex.run(() =>
          this.begin(async (executor) => {
            const context = { executor, active: true };
            try {
              return await this.scope.run(context, work);
            } finally {
              context.active = false;
            }
          }),
        );
      },
    };
  }

  async acquireLease(key: string, ttlMs: number): Promise<string | null> {
    if (!key || !Number.isFinite(ttlMs) || ttlMs <= 0)
      throw new Error("Invalid database lease.");
    const token = randomUUID();
    const now = Date.now();
    const result = await this.prepare(
      `INSERT INTO database_leases (key, token, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at
      WHERE database_leases.expires_at <= ?`,
    ).run(key, token, now + ttlMs, now);
    return result.changes === 1 ? token : null;
  }

  async releaseLease(key: string, token: string): Promise<void> {
    await this.prepare(
      "DELETE FROM database_leases WHERE key = ? AND token = ?",
    ).run(key, token);
  }

  close() {
    this.closed = true;
    this.remote?.close();
    this.local?.close();
  }
}
