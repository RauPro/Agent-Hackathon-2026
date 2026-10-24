import { createHash, randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import {
  DIALOGUE_TURN_LIMIT,
  DIALOGUE_MIN_TURNS,
  dialogueActionSchema,
  dialogueReplySchema,
  type AgentDialogue,
  type DialogueAction,
  type DialogueCompleter,
  type DialogueModelInput,
  type DialogueStatus,
  type DialogueTurn,
} from "../domain/agent-dialogue";
import type { SharedProfile } from "../domain/network";
import { completeAgentDialogue } from "./agent-dialogue-model";
import { NetworkError, NetworkStore } from "./network-store";

const LEASE_MS = 45_000;
const DAILY_CALL_LIMIT = 24;
const pair = (a: string, b: string) => [a, b].sort() as [string, string];
const now = () => new Date().toISOString();
const budgetDay = () => Temporal.Now.plainDateISO("America/Los_Angeles").toString();
type DialogueState = {
  turns: DialogueTurn[];
  nextActorUserId: string;
  waitingForUserId: string | null;
  question: string | null;
  suggestion: string | null;
  pausedByUserId: string | null;
  resumeStatus: DialogueStatus | null;
  callDay: string;
  dailyCalls: number;
};
type DialogueRow = {
  id: string;
  user_a: string;
  user_b: string;
  fingerprint: string;
  revision: number;
  status: DialogueStatus;
  state_json: string;
  created_at: string;
  updated_at: string;
};
type Snapshot = {
  connected: boolean;
  fingerprint: string;
  profiles: Record<string, SharedProfile>;
  profileReady: Record<string, boolean>;
  sharingReady: Record<string, boolean>;
  status: "revoked" | "awaiting_profile" | "awaiting_sharing" | "queued";
};

/** One shared runtime, with one durable and permission-scoped round per connection. */
export class AgentDialogueService {
  constructor(
    readonly network: NetworkStore,
    private readonly complete: DialogueCompleter = completeAgentDialogue,
  ) {}

  private get db() {
    return this.network.db;
  }

  private async row(a: string, b: string) {
    return (await this.db.prepare(
      "SELECT * FROM agent_dialogues WHERE user_a = ? AND user_b = ?",
    ).get(...pair(a, b))) as DialogueRow | undefined;
  }

  private async snapshot(a: string, b: string): Promise<Snapshot> {
    const relationship = (await this.db.prepare(
      `SELECT revision, status,
        EXISTS(SELECT 1 FROM network_blocks WHERE
          (user_id = ? AND blocked_user_id = ?) OR (user_id = ? AND blocked_user_id = ?)) AS blocked
       FROM network_connections WHERE user_a = ? AND user_b = ?`,
    ).get(a, b, b, a, a, b)) as { revision: number; status: string; blocked: number } | undefined;
    const connected = relationship?.status === "accepted" && !relationship.blocked;
    const profiles: Record<string, SharedProfile> = {};
    const profileReady: Record<string, boolean> = {};
    const sharingReady: Record<string, boolean> = {};
    const metadata = connected ? await this.db.prepare(
      `SELECT u.id, s.revision, s.confirmed_at, s.context_json IS NOT NULL AS has_context,
       ns.settings_json FROM users u JOIN sessions s ON s.token_hash = u.profile_id
       LEFT JOIN network_settings ns ON ns.user_id = u.id WHERE u.id IN (?, ?) ORDER BY u.id`,
    ).all(a, b) : [];
    for (const owner of [a, b]) {
      const item = metadata.find((item) => item.id === owner);
      profileReady[owner] = !!item?.has_context && !!item.confirmed_at;
      // Even an agent's own context is restricted to what its peer may see.
      if (connected && profileReady[owner])
        profiles[owner] = await this.network.project(owner === a ? b : a, owner);
      sharingReady[owner] = !!(profiles[owner]?.profile || profiles[owner]?.goal);
    }
    const status = !connected ? "revoked"
      : !profileReady[a] || !profileReady[b] ? "awaiting_profile"
      : !sharingReady[a] || !sharingReady[b] ? "awaiting_sharing" : "queued";
    // Private context edits must not restart a shared conversation. Settings and
    // authorized content (including event contents) still fence every model turn.
    const permissions = metadata.map((item) => ({ id: item.id, ready: profileReady[String(item.id)], settings: item.settings_json }));
    const sharedContent = Object.fromEntries(Object.entries(profiles).map(([id, profile]) => {
      const { revision: _revision, ...content } = profile;
      void _revision;
      return [id, content];
    }));
    const fingerprint = createHash("sha256").update(JSON.stringify({ relationship, permissions, sharedContent })).digest("hex");
    return { connected, fingerprint, profiles, profileReady, sharingReady, status };
  }

  private emptyState(a: string, previous?: DialogueState): DialogueState {
    return {
      turns: [], nextActorUserId: a, waitingForUserId: null, question: null,
      suggestion: null, pausedByUserId: previous?.pausedByUserId ?? null,
      resumeStatus: null, callDay: previous?.callDay ?? budgetDay(),
      dailyCalls: previous?.dailyCalls ?? 0,
    };
  }

  private async write(row: DialogueRow, state: DialogueState, status: DialogueStatus) {
    row.revision += 1;
    row.status = status;
    row.state_json = JSON.stringify(state);
    row.updated_at = now();
    await this.db.prepare(
      `UPDATE agent_dialogues SET fingerprint = ?, revision = ?, status = ?, state_json = ?, updated_at = ? WHERE id = ?`,
    ).run(row.fingerprint, row.revision, status, row.state_json, row.updated_at, row.id);
    return row;
  }

  // Call only inside a short transaction. This never invokes a model or calendar.
  private async reconcile(a: string, b: string) {
    const snapshot = await this.snapshot(a, b);
    let row = await this.row(a, b);
    if (!row) {
      if (!snapshot.connected) return { row, snapshot };
      const createdAt = now();
      row = {
        id: randomUUID(), user_a: a, user_b: b, fingerprint: snapshot.fingerprint,
        revision: 0, status: snapshot.status, state_json: JSON.stringify(this.emptyState(a)),
        created_at: createdAt, updated_at: createdAt,
      };
      await this.db.prepare(
        `INSERT INTO agent_dialogues (id, user_a, user_b, fingerprint, revision, status, state_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.id, a, b, row.fingerprint, row.revision, row.status, row.state_json, createdAt, createdAt);
    } else if (row.fingerprint !== snapshot.fingerprint) {
      const state = this.emptyState(a, JSON.parse(row.state_json) as DialogueState);
      row.fingerprint = snapshot.fingerprint;
      state.resumeStatus = state.pausedByUserId ? snapshot.status : null;
      // Generated text and one-off answers belong only to the current permission snapshot.
      row = await this.write(row, state, snapshot.connected && state.pausedByUserId ? "paused" : snapshot.status);
    }
    return { row, snapshot };
  }

  async syncPair(first: string, second: string): Promise<void> {
    if (first === second) return;
    await this.db.transaction(async () => { await this.reconcile(...pair(first, second)); }).immediate();
  }

  async syncForUser(userId: string): Promise<void> {
    const pairs = await this.db.prepare(
      `SELECT user_a, user_b FROM network_connections WHERE status = 'accepted' AND (user_a = ? OR user_b = ?)
       UNION SELECT user_a, user_b FROM agent_dialogues WHERE user_a = ? OR user_b = ?`,
    ).all(userId, userId, userId, userId);
    for (const row of pairs) await this.syncPair(String(row.user_a), String(row.user_b));
  }

  private view(row: DialogueRow, snapshot: Snapshot, userId: string): AgentDialogue {
    const state = JSON.parse(row.state_json) as DialogueState;
    const peerId = row.user_a === userId ? row.user_b : row.user_a;
    const details: Record<DialogueStatus, string> = {
      awaiting_profile: snapshot.profileReady[userId] ? "Waiting for your connection to confirm their profile." : "Confirm your profile to start the conversation.",
      awaiting_sharing: snapshot.sharingReady[userId] ? "Waiting for your connection to share their experience or goal." : "Share your experience or goal with connections to start the conversation.",
      queued: "Your Sidekicks will continue the conversation shortly.",
      running: "Your Sidekicks are talking.",
      needs_user: state.waitingForUserId === userId ? "Your Sidekick has a question for you." : "Waiting for your connection to answer their Sidekick.",
      completed: "This conversation is complete. Confirmed profile or sharing changes can start a new round.",
      paused: state.pausedByUserId === userId ? "You paused this conversation." : "Your connection paused this conversation.",
      error: state.callDay === budgetDay() && state.dailyCalls >= DAILY_CALL_LIMIT ? "Today's conversation limit was reached. Try again tomorrow." : "The conversation could not continue. You can retry.",
      revoked: "This connection is no longer available.",
    };
    return {
      id: row.id, userId: peerId, name: snapshot.profiles[peerId]?.name ?? "Sidekick member",
      revision: row.revision, status: row.status, statusDetail: details[row.status],
      turns: snapshot.connected ? state.turns : [], waitingForUserId: snapshot.connected ? state.waitingForUserId : null,
      question: snapshot.connected ? state.question : null, suggestion: snapshot.connected ? state.suggestion : null,
      pausedByUserId: state.pausedByUserId, ownProfileReady: !!snapshot.profileReady[userId],
      ownSharingReady: !!snapshot.sharingReady[userId], updatedAt: row.updated_at,
    };
  }

  async list(userId: string): Promise<AgentDialogue[]> {
    await this.syncForUser(userId);
    const pairs = await this.db.prepare(
      "SELECT user_a, user_b FROM agent_dialogues WHERE user_a = ? OR user_b = ? ORDER BY updated_at DESC",
    ).all(userId, userId);
    const result: AgentDialogue[] = [];
    for (const item of pairs) {
      const view = await this.db.transaction(async () => {
        const { row, snapshot } = await this.reconcile(String(item.user_a), String(item.user_b));
        return row ? this.view(row, snapshot, userId) : null;
      }).immediate();
      if (view) result.push(view);
    }
    return result;
  }

  async act(userId: string, input: DialogueAction): Promise<AgentDialogue> {
    const action = dialogueActionSchema.parse(input);
    return this.db.transaction(async () => {
      const { row, snapshot } = await this.reconcile(...pair(userId, action.toUserId));
      if (!row || !snapshot.connected) throw new NetworkError("not_available", 403);
      if (row.revision !== action.revision) throw new NetworkError("stale_revision", 409, "This conversation changed. Reload and try again.");
      const state = JSON.parse(row.state_json) as DialogueState;
      let status = row.status;
      if (action.operation === "pause") {
        if (state.pausedByUserId && state.pausedByUserId !== userId) throw new NetworkError("not_available", 403);
        if (status !== "paused") {
          state.resumeStatus = status === "running" ? "queued" : status;
          state.pausedByUserId = userId;
          status = "paused";
        }
      } else if (action.operation === "resume") {
        if (status !== "paused" || state.pausedByUserId !== userId) throw new NetworkError("not_available", 403);
        status = state.resumeStatus ?? snapshot.status;
        state.pausedByUserId = null;
        state.resumeStatus = null;
      } else if (action.operation === "retry") {
        if (status !== "error") throw new NetworkError("not_available", 409);
        if (state.callDay === budgetDay() && state.dailyCalls >= DAILY_CALL_LIMIT)
          throw new NetworkError("rate_limit", 429, "Try continuing this conversation tomorrow.");
        status = "queued";
      } else {
        if (status !== "needs_user" || state.waitingForUserId !== userId) throw new NetworkError("not_available", 403);
        if (action.operation === "answer") {
          state.turns.push({ id: randomUUID(), actorUserId: userId, kind: "user", text: action.answer!, at: now() });
          status = "queued";
        } else {
          state.turns.push({ id: randomUUID(), actorUserId: userId, kind: "user", text: "I prefer not to share more information.", at: now() });
          state.suggestion = null;
          status = "completed";
        }
        state.waitingForUserId = null;
        state.question = null;
      }
      await this.write(row, state, status);
      return this.view(row, snapshot, userId);
    }).immediate();
  }

  private async step(a: string, b: string): Promise<boolean> {
    const leaseKey = `agent-dialogue:${a}:${b}`;
    const lease = await this.db.acquireLease(leaseKey, LEASE_MS);
    if (!lease) return false;
    try {
      const claim = await this.db.transaction(async () => {
        const { row, snapshot } = await this.reconcile(a, b);
        if (!row || !["queued", "running"].includes(row.status) || snapshot.status !== "queued") return null;
        const state = JSON.parse(row.state_json) as DialogueState;
        const agentTurns = state.turns.filter((turn) => turn.kind === "agent").length;
        if (agentTurns >= DIALOGUE_TURN_LIMIT) { await this.write(row, state, "completed"); return null; }
        if (state.callDay !== budgetDay()) { state.callDay = budgetDay(); state.dailyCalls = 0; }
        if (state.dailyCalls >= DAILY_CALL_LIMIT) { await this.write(row, state, "error"); return null; }
        state.dailyCalls += 1;
        await this.write(row, state, "running");
        const actor = state.nextActorUserId;
        const peer = actor === a ? b : a;
        const input: DialogueModelInput = {
          self: snapshot.profiles[actor], peer: snapshot.profiles[peer],
          history: state.turns.map((turn) => ({
            speaker: turn.kind === "user" ? turn.actorUserId === actor ? "user" : "peer" : turn.actorUserId === actor ? "self" : "peer",
            text: turn.kind === "user" ? `${turn.actorUserId === actor ? "My user" : "The other user"}: ${turn.text}` : turn.text,
          })), turnNumber: agentTurns + 1, turnLimit: DIALOGUE_TURN_LIMIT,
        };
        return { row, state, actor, peer, input };
      }).immediate();
      if (!claim) return false;
      let result: ReturnType<typeof dialogueReplySchema.parse> | null = null;
      try {
        const parsed = dialogueReplySchema.parse(await this.complete(claim.input));
        if ((parsed.next === "ask_user") !== (parsed.questionForUser !== null)) throw new Error("Invalid dialogue transition.");
        result = parsed;
      }
      catch { /* Persist a retryable error, never substitute a fabricated exchange. */ }
      await this.db.transaction(async () => {
        const { row, snapshot } = await this.reconcile(a, b);
        const fenced = await this.db.prepare(
          "SELECT 1 FROM database_leases WHERE key = ? AND token = ? AND expires_at > ?",
        ).get(leaseKey, lease, Date.now());
        if (!fenced || !row || snapshot.status !== "queued" || row.status !== "running" ||
          row.revision !== claim.row.revision || row.fingerprint !== claim.row.fingerprint) return;
        const state = claim.state;
        if (!result) { await this.write(row, state, "error"); return; }
        state.turns.push({ id: randomUUID(), actorUserId: claim.actor, kind: "agent", text: result.message, at: now() });
        state.nextActorUserId = claim.peer;
        state.suggestion = result.suggestedNextStep;
        const atLimit = claim.input.turnNumber >= DIALOGUE_TURN_LIMIT;
        const needsUser = !atLimit && result.next === "ask_user" && !!result.questionForUser;
        state.waitingForUserId = needsUser ? claim.actor : null;
        state.question = needsUser ? result.questionForUser : null;
        const completed = atLimit || (result.next === "complete" && claim.input.turnNumber >= DIALOGUE_MIN_TURNS);
        await this.write(row, state, completed ? "completed" : needsUser ? "needs_user" : "queued");
      }).immediate();
      return true;
    } finally { await this.db.releaseLease(leaseKey, lease); }
  }

  async drain(limit = 2): Promise<number> {
    let processed = 0;
    const safeLimit = Math.max(0, Math.min(6, Math.floor(limit)));
    for (let i = 0; i < safeLimit; i += 1) {
      const rows = await this.db.prepare(
        "SELECT user_a, user_b FROM agent_dialogues WHERE status IN ('queued', 'running') ORDER BY updated_at, id LIMIT 10",
      ).all();
      let advanced = false;
      for (const row of rows) {
        if (await this.step(String(row.user_a), String(row.user_b))) { processed += 1; advanced = true; break; }
      }
      if (!advanced) break;
    }
    return processed;
  }
}
