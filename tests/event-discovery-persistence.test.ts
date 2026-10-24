import { createClient as createLocalClient } from "@libsql/client";
import * as remoteLibsql from "@libsql/client/web";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  DISCOVERY_LIMITS,
  emptyCoverage,
  type DiscoveryRequest,
} from "@/lib/domain/event-discovery";
import { ContextStore } from "@/lib/server/store";
import { discoveryNow } from "./discovery-fixtures";
import { validContext } from "./fixtures";

vi.mock("@libsql/client/web", () => ({ createClient: vi.fn() }));
const stores: ContextStore[] = [];
const folders: string[] = [];
function file() {
  const folder = mkdtempSync(join(tmpdir(), "sidekick-events-integration-"));
  folders.push(folder);
  return join(folder, "fixture.sqlite");
}
function connect(path: string, remote = false) {
  if (remote)
    vi.mocked(remoteLibsql.createClient).mockReturnValue(
      createLocalClient({ url: `file:${path}` }),
    );
  const store = new ContextStore(
    remote
      ? {
          url: "https://fixture.example.test",
          authToken: "fixture",
          purpose: "production",
        }
      : path,
  );
  stores.push(store);
  return store;
}
const request = (revision = 1): DiscoveryRequest => ({
  action: "start",
  revision,
  requestId: crypto.randomUUID(),
});
async function account(store: ContextStore) {
  const login = await store.registerAccount(
    `${crypto.randomUUID()}@example.test`,
    "fixture-hash",
  );
  await store.save(login.token, {
    context: validContext(),
    baseRevision: 0,
    requestId: crypto.randomUUID(),
  });
  return login;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "preserves events, QR relationships and calendar state through restart (libSQL adapter: %s)",
  async (remote) => {
    // The remote adapter uses the real libSQL API with a disposable file, never live Turso.
    const path = file(),
      store = connect(path, remote);
    const a = await account(store),
      b = await account(store);
    await store.network.requestConnection(a.account.id, b.account.id, {
      source: "qr",
      token: (await store.network.settings(b.account.id)).qrToken,
      context: "Fixture meeting",
    });
    await store.network.connectionAction(b.account.id, a.account.id, "accept");
    const calendar = {
      subject: "fixture-subject",
      email: "fixture@example.test",
      encryptedTokens: "opaque-fixture",
      calendars: [
        {
          id: "primary",
          name: "Personal",
          primary: true,
          timezone: "America/Los_Angeles",
        },
      ],
      selectedIds: ["primary"],
      snapshot: null,
      issue: null,
    };
    await store.writeCalendar(a.token, 0, calendar);
    const input = request(),
      claim = await store.claimDiscovery(a.token, input, discoveryNow(), true);
    expect(claim.claimed).toBe(true);
    const coverage = emptyCoverage();
    expect(
      await store.finishDiscovery(
        claim.owner,
        1,
        claim.row.run_id,
        "empty",
        {
          recommendations: [],
          coverage,
          checkedAt: discoveryNow().toISOString(),
        },
        coverage,
        null,
        discoveryNow(),
      ),
    ).toBe(true);
    const saved = await store.readDiscovery(a.token, discoveryNow());
    expect(saved?.status).toBe("empty");
    expect(await store.readDiscovery(b.token, discoveryNow())).toBeNull();
    expect(
      await store.discoveryCoverage(
        await store.calendarOwner(b.token),
        claim.row.run_id,
      ),
    ).toBeNull();
    expect(
      (await store.claimDiscovery(a.token, input, discoveryNow(), true))
        .claimed,
    ).toBe(false);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restored = connect(path, remote);
    expect(await restored.readDiscovery(a.token, discoveryNow())).toEqual(
      saved,
    );
    expect((await restored.discoveryDailyUsage(discoveryNow())).used).toBe(1);
    expect((await restored.readCalendar(a.token)).connection).toEqual(calendar);
    expect(await restored.network.isConnected(a.account.id, b.account.id)).toBe(
      true,
    );
    expect(
      await restored.db
        .prepare("SELECT user_id FROM network_jobs WHERE user_id = ?")
        .get(a.account.id),
    ).toBeDefined();
    // Profile changes queue people matching and cannot accept an old event result.
    const updated = validContext();
    updated.goal.text = "Find design partners for a new agent product";
    await restored.save(a.token, {
      context: updated,
      baseRevision: 1,
      requestId: crypto.randomUUID(),
    });
    expect(await restored.readDiscovery(a.token, discoveryNow())).toBeNull();
    expect(
      await restored.finishDiscovery(
        claim.owner,
        1,
        claim.row.run_id,
        "failed",
        null,
        coverage,
        "interrupted",
        discoveryNow(),
      ),
    ).toBe(false);
  },
);

it("serializes duplicate claims and applies the daily cap across independent stores", async () => {
  vi.stubEnv("DISCOVERY_DAILY_RUN_LIMIT", "1");
  const path = file(),
    first = connect(path),
    second = connect(path);
  const a = await account(first),
    b = await account(second),
    input = request();
  const claims = await Promise.all([
    first.claimDiscovery(a.token, input, discoveryNow(), true),
    second.claimDiscovery(a.token, input, discoveryNow(), true),
  ]);
  expect(claims.filter((c) => c.claimed)).toHaveLength(1);
  expect(claims[0].row.run_id).toBe(claims[1].row.run_id);
  await expect(
    second.claimDiscovery(b.token, request(), discoveryNow(), true),
  ).rejects.toThrow("daily_limit");
  expect((await first.discoveryDailyUsage(discoveryNow())).used).toBe(1);
});

it("enforces shared capacity without a process-local active map and reclaims expired leases", async () => {
  vi.stubEnv("DISCOVERY_DAILY_RUN_LIMIT", "100");
  const path = file(),
    first = connect(path),
    second = connect(path);
  const users = await Promise.all(
    Array.from({ length: DISCOVERY_LIMITS.concurrent + 1 }, () =>
      account(first),
    ),
  );
  await Promise.all(
    users
      .slice(0, -1)
      .map((u) =>
        first.claimDiscovery(u.token, request(), discoveryNow(), true),
      ),
  );
  const last = users.at(-1)!;
  await expect(
    second.claimDiscovery(last.token, request(), discoveryNow(), true),
  ).rejects.toThrow("busy");
  const later = new Date(
    discoveryNow().getTime() + DISCOVERY_LIMITS.leaseMs + 1,
  );
  expect(
    (await second.claimDiscovery(last.token, request(), later, true)).claimed,
  ).toBe(true);
  expect((await first.readDiscovery(users[0].token, later))?.error_code).toBe(
    "interrupted",
  );
});
