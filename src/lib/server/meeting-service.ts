import { createHash, randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type Database from "better-sqlite3";
import {
  calendarWindow,
  type CalendarConnection,
  type CalendarRecord,
  type CalendarWindow,
} from "@/lib/domain/calendar";
import {
  SF_TIMEZONE,
  windowInstants,
  type ContextState,
  type UserContext,
} from "@/lib/domain/context";
import {
  meetingApprovalSchema,
  meetingOptInSchema,
  meetingRevisionSchema,
  proposeMeetingSchema,
  type MeetingOption,
  type MeetingSlot,
  type MeetingStatus,
  type MeetingView,
} from "@/lib/domain/meetings";
import { openCalendarData, sealCalendarData } from "./calendar-crypto";
import {
  CalendarError,
  googleBusy,
  googleCalendarConfig,
  hasCalendarScopes,
  refreshGoogleTokens,
  tokenDataSchema,
} from "./google-calendar";
import type { ContextStore } from "./store";

const HALF_HOUR = 30 * 60 * 1000;
const liveStatuses: MeetingStatus[] = ["awaiting_permission", "options_ready"];
type Consent = { at: string; manualSlots: MeetingSlot[] | null };
type MeetingRecord = {
  id: string;
  revision: number;
  initiatorId: string;
  participants: [string, string];
  names: Record<string, string>;
  purpose: string;
  location: string | null;
  status: MeetingStatus;
  contextRevisions: Record<string, number>;
  relationshipRevision: number;
  consents: Record<string, Consent>;
  approvals: Record<string, string>;
  options: MeetingOption[];
  selectedOptionId: string | null;
  availabilitySource: MeetingView["availabilitySource"];
  checkedAt: string | null;
  createdAt: string;
  expiresAt: string;
  error: string | null;
};
type NetworkAccess = {
  db: Database.Database;
  profile(userId: string): ContextState;
  isConnected(a: string, b: string): boolean;
  blocked(a: string, b: string): boolean;
  relationshipRevision(a: string, b: string): number;
};
type Coverage = {
  busy: MeetingSlot[];
  manual: MeetingSlot[] | null;
  revision: number;
  source: "google" | "manual";
};
type CalendarOwner = CalendarRecord & { owner: string };

const meetingErrors = {
  not_found: [404, "This meeting is not available to your account."],
  not_connected: [
    403,
    "Connect with this person before coordinating a meeting.",
  ],
  profile_required: [
    409,
    "Both participants need a confirmed profile before meeting.",
  ],
  meeting_changed: [
    409,
    "This proposal changed. Refresh it or start a new proposal.",
  ],
  meeting_expired: [
    409,
    "This meeting proposal expired. Start a new proposal.",
  ],
  meeting_closed: [409, "This proposal is no longer open for changes."],
  manual_required: [400, "Add a time when you are available to meet."],
  manual_not_allowed: [
    400,
    "Your connected calendar supplies availability. Reconnect it if it cannot be checked.",
  ],
  invalid_manual_slots: [
    400,
    "Choose a future availability window within your SF stay.",
  ],
  calendar_unavailable: [
    503,
    "A calendar could not be checked. Reconnect your calendar or try again.",
  ],
  availability_changed: [409, "Availability changed. Check for another time."],
  no_slots: [
    409,
    "Your upcoming stays do not overlap. Update your trip dates before proposing another meeting.",
  ],
  location_required: [
    400,
    "Agree on a meeting place before confirming a time.",
  ],
  approval_required: [
    403,
    "Both participants need to approve this meeting first.",
  ],
  invalid_option: [409, "Choose one of the current proposed times."],
  request_conflict: [
    409,
    "This request was already used for a different proposal.",
  ],
  rate_limit: [
    429,
    "You have proposed ten meetings today. Try again tomorrow.",
  ],
} as const;

export class MeetingError extends Error {
  readonly kind = "meeting_error";
  readonly status: number;
  constructor(public code: keyof typeof meetingErrors) {
    super(meetingErrors[code][1]);
    this.status = meetingErrors[code][0];
  }
}

export class MeetingService {
  private network: NetworkAccess;
  private db: Database.Database;
  constructor(store: ContextStore) {
    this.network = store.network;
    this.db = this.network.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY, initiator_id TEXT NOT NULL REFERENCES users(id),
      first_user_id TEXT NOT NULL REFERENCES users(id), second_user_id TEXT NOT NULL REFERENCES users(id),
      request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL,
      UNIQUE(initiator_id, request_id)
    ); CREATE INDEX IF NOT EXISTS meetings_first ON meetings(first_user_id);
    CREATE INDEX IF NOT EXISTS meetings_second ON meetings(second_user_id);`);
  }

  private requireUser(userId: string) {
    if (!this.db.prepare("SELECT id FROM users WHERE id = ?").get(userId))
      throw new MeetingError("not_found");
  }
  private relationship(a: string, b: string) {
    if (
      a === b ||
      !this.network.isConnected(a, b) ||
      this.network.blocked(a, b)
    )
      throw new MeetingError("not_connected");
  }
  private context(userId: string) {
    const profile = this.network.profile(userId);
    if (!profile.context || !profile.confirmedAt)
      throw new MeetingError("profile_required");
    return profile as ContextState & { context: UserContext };
  }
  private read(actorId: string, meetingId: string) {
    const row = this.db
      .prepare(
        "SELECT state_json FROM meetings WHERE id = ? AND (first_user_id = ? OR second_user_id = ?)",
      )
      .get(meetingId, actorId, actorId) as { state_json: string } | undefined;
    if (!row) throw new MeetingError("not_found");
    return JSON.parse(row.state_json) as MeetingRecord;
  }
  private save(value: MeetingRecord, expected: number) {
    const next = { ...value, revision: expected + 1 };
    const result = this.db
      .prepare(
        "UPDATE meetings SET revision = ?, state_json = ? WHERE id = ? AND revision = ?",
      )
      .run(next.revision, JSON.stringify(next), value.id, expected);
    if (result.changes !== 1) throw new MeetingError("meeting_changed");
    return next;
  }
  private current(value: MeetingRecord) {
    this.relationship(...value.participants);
    if (
      this.network.relationshipRevision(...value.participants) !==
      value.relationshipRevision
    )
      throw new MeetingError("meeting_changed");
    if (
      value.status !== "confirmed" &&
      Date.parse(value.expiresAt) <= Date.now()
    )
      throw new MeetingError("meeting_expired");
    for (const id of value.participants) {
      if (this.context(id).revision !== value.contextRevisions[id])
        throw new MeetingError("meeting_changed");
    }
  }
  private writable(actorId: string, meetingId: string, revision: number) {
    const value = this.read(actorId, meetingId);
    if (value.revision !== revision) throw new MeetingError("meeting_changed");
    this.current(value);
    if (!liveStatuses.includes(value.status))
      throw new MeetingError("meeting_closed");
    return value;
  }
  private calendar(userId: string): CalendarOwner {
    const owner = this.db
      .prepare("SELECT profile_id FROM users WHERE id = ?")
      .get(userId) as { profile_id: string } | undefined;
    if (!owner) throw new MeetingError("not_found");
    const record = this.db
      .prepare(
        "SELECT revision, connection_json FROM calendar_connections WHERE session_id = ?",
      )
      .get(owner.profile_id) as
      | { revision: number; connection_json: string | null }
      | undefined;
    return {
      owner: owner.profile_id,
      revision: record?.revision ?? 0,
      connection: record?.connection_json
        ? (JSON.parse(record.connection_json) as CalendarConnection)
        : null,
    };
  }
  private saveCalendar(record: CalendarOwner, connection: CalendarConnection) {
    const result = this.db
      .prepare(
        "UPDATE calendar_connections SET revision = revision + 1, connection_json = ? WHERE session_id = ? AND revision = ?",
      )
      .run(JSON.stringify(connection), record.owner, record.revision);
    if (result.changes !== 1) throw new MeetingError("availability_changed");
    return { ...record, revision: record.revision + 1, connection };
  }
  private view(actorId: string, record: MeetingRecord): MeetingView {
    let value = record;
    if (liveStatuses.includes(value.status) || value.status === "confirmed") {
      try {
        this.current(value);
      } catch (error) {
        const status =
          error instanceof MeetingError && error.code === "meeting_expired"
            ? "expired"
            : "stale";
        value = this.save(
          {
            ...value,
            status,
            options: [],
            approvals: {},
            selectedOptionId: null,
            error:
              status === "expired"
                ? "This proposal expired. Start a new one."
                : "The profile or relationship changed. Start a new proposal.",
          },
          value.revision,
        );
      }
    }
    return {
      id: value.id,
      revision: value.revision,
      initiatorId: value.initiatorId,
      participants: value.participants.map((id) => ({
        userId: id,
        name: value.names[id],
      })),
      purpose: value.purpose,
      location: value.location,
      status: value.status,
      durationMinutes: 30,
      timezone: SF_TIMEZONE,
      options: value.options,
      selectedOptionId: value.selectedOptionId,
      consentedUserIds: Object.keys(value.consents),
      approvedUserIds: Object.keys(value.approvals),
      manualAvailabilityNeeded: !this.calendar(actorId).connection,
      availabilitySource: value.availabilitySource,
      checkedAt: value.checkedAt,
      expiresAt: value.expiresAt,
      calendarStatus:
        value.status === "confirmed" ? "export_available" : "not_ready",
      error: value.error,
    };
  }
  list(actorId: string): MeetingView[] {
    this.requireUser(actorId);
    const rows = this.db
      .prepare(
        "SELECT state_json FROM meetings WHERE first_user_id = ? OR second_user_id = ? ORDER BY rowid DESC LIMIT 50",
      )
      .all(actorId, actorId) as { state_json: string }[];
    return rows.map((row) =>
      this.view(actorId, JSON.parse(row.state_json) as MeetingRecord),
    );
  }
  propose(
    actorId: string,
    raw: {
      toUserId: string;
      requestId: string;
      purpose: string;
      location?: string;
    },
  ): MeetingView {
    const input = proposeMeetingSchema.parse(raw);
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const result = this.db
      .transaction(() => {
        this.requireUser(actorId);
        const previous = this.db
          .prepare(
            "SELECT payload_hash, state_json FROM meetings WHERE initiator_id = ? AND request_id = ?",
          )
          .get(actorId, input.requestId) as
          | { payload_hash: string; state_json: string }
          | undefined;
        if (previous) {
          if (previous.payload_hash !== payloadHash)
            throw new MeetingError("request_conflict");
          return JSON.parse(previous.state_json) as MeetingRecord;
        }
        this.relationship(actorId, input.toUserId);
        const count = this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM meetings WHERE initiator_id = ? AND json_extract(state_json, '$.createdAt') > ?",
          )
          .get(actorId, new Date(Date.now() - 86400000).toISOString()) as {
          n: number;
        };
        if (count.n >= 10) throw new MeetingError("rate_limit");
        const participants: [string, string] = [actorId, input.toUserId];
        const profiles = participants.map((id) => this.context(id));
        const value: MeetingRecord = {
          id: randomUUID(),
          revision: 1,
          initiatorId: actorId,
          participants,
          names: Object.fromEntries(
            participants.map((id, index) => [
              id,
              profiles[index].context.profile.name,
            ]),
          ),
          purpose: input.purpose,
          location: input.location ?? null,
          status: "awaiting_permission",
          contextRevisions: Object.fromEntries(
            participants.map((id, index) => [id, profiles[index].revision]),
          ),
          relationshipRevision: this.network.relationshipRevision(
            ...participants,
          ),
          consents: {},
          approvals: {},
          options: [],
          selectedOptionId: null,
          availabilitySource: null,
          checkedAt: null,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 48 * 3600000).toISOString(),
          error: null,
        };
        this.db
          .prepare(
            "INSERT INTO meetings (id, initiator_id, first_user_id, second_user_id, request_id, payload_hash, revision, state_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            value.id,
            actorId,
            ...participants,
            input.requestId,
            payloadHash,
            1,
            JSON.stringify(value),
          );
        return value;
      })
      .immediate();
    return this.view(actorId, result);
  }
  async optIn(
    actorId: string,
    raw: { meetingId: string; revision: number; manualSlots?: MeetingSlot[] },
  ): Promise<MeetingView> {
    const input = meetingOptInSchema.parse(raw);
    const value = this.db
      .transaction(() => {
        const current = this.writable(actorId, input.meetingId, input.revision);
        const calendar = this.calendar(actorId);
        if (calendar.connection && input.manualSlots)
          throw new MeetingError("manual_not_allowed");
        if (
          !calendar.connection &&
          !input.manualSlots?.length &&
          !current.consents[actorId]?.manualSlots?.length
        )
          throw new MeetingError("manual_required");
        const manual = calendar.connection
          ? null
          : (input.manualSlots ??
            current.consents[actorId]?.manualSlots ??
            null);
        if (manual) {
          const trip = this.context(actorId).context.trip;
          const limits = calendarWindow(trip.start, trip.end)!;
          if (
            manual.some(
              (slot) =>
                Date.parse(slot.start) < Date.parse(limits.timeMin) ||
                Date.parse(slot.end) > Date.parse(limits.timeMax) ||
                Date.parse(slot.end) <= Date.now(),
            )
          )
            throw new MeetingError("invalid_manual_slots");
        }
        return this.save(
          {
            ...current,
            status: "awaiting_permission",
            consents: {
              ...current.consents,
              [actorId]: { at: new Date().toISOString(), manualSlots: manual },
            },
            options: [],
            selectedOptionId: null,
            approvals: {},
            error: null,
          },
          current.revision,
        );
      })
      .immediate();
    if (value.participants.every((id) => value.consents[id])) {
      try {
        const available = await this.availability(value);
        const updated = this.db
          .transaction(() => {
            const current = this.writable(actorId, value.id, value.revision);
            this.validateCoverage(current, available.coverages);
            if (!available.options.length)
              return this.save(
                {
                  ...current,
                  error:
                    "No common time was found in the next 14 days of your overlapping stays.",
                },
                current.revision,
              );
            return this.save(
              {
                ...current,
                status: "options_ready",
                options: available.options,
                availabilitySource: available.source,
                checkedAt: new Date().toISOString(),
                error: null,
              },
              current.revision,
            );
          })
          .immediate();
        return this.view(actorId, updated);
      } catch (error) {
        this.recordFailure(actorId, value, error);
        throw error;
      }
    }
    return this.view(actorId, value);
  }
  private recordFailure(actorId: string, value: MeetingRecord, error: unknown) {
    const current = this.read(actorId, value.id);
    if (current.revision !== value.revision) return;
    this.save(
      {
        ...current,
        status: "awaiting_permission",
        options: [],
        selectedOptionId: null,
        approvals: {},
        error:
          error instanceof MeetingError && error.code === "no_slots"
            ? "Your upcoming stays do not overlap. Update your trip dates before proposing another meeting."
            : error instanceof MeetingError &&
                error.code === "availability_changed"
              ? "Availability changed. Check for another time."
              : "Availability could not be checked. Reconnect your calendar or try again.",
      },
      current.revision,
    );
  }
  private bounds(value: MeetingRecord): CalendarWindow {
    const [a, b] = value.participants.map(
      (id) => this.context(id).context.trip,
    );
    const today = Temporal.Now.plainDateISO(SF_TIMEZONE).toString();
    const start = [a.start, b.start, today].sort().at(-1)!;
    const end = [
      a.end,
      b.end,
      Temporal.PlainDate.from(start).add({ days: 13 }).toString(),
    ].sort()[0];
    const window = calendarWindow(start, end);
    if (!window) throw new MeetingError("no_slots");
    return window;
  }
  private async coverage(
    userId: string,
    consent: Consent,
    window: CalendarWindow,
  ): Promise<Coverage> {
    let record = this.calendar(userId);
    if (!record.connection) {
      if (!consent.manualSlots?.length)
        throw new MeetingError("manual_required");
      return {
        busy: [],
        manual: consent.manualSlots,
        revision: record.revision,
        source: "manual",
      };
    }
    if (consent.manualSlots) throw new MeetingError("availability_changed");
    if (!googleCalendarConfig()) throw new MeetingError("calendar_unavailable");
    try {
      let tokens = tokenDataSchema.parse(
        openCalendarData(record.connection.encryptedTokens, record.owner),
      );
      if (!hasCalendarScopes(tokens.scopes))
        throw new CalendarError("needs_reconnect");
      const signal = AbortSignal.timeout(25000);
      if (tokens.expiresAt < Date.now() + 60000) {
        tokens = await refreshGoogleTokens(tokens, signal);
        record = this.saveCalendar(record, {
          ...record.connection,
          encryptedTokens: sealCalendarData(tokens, record.owner),
        });
      }
      const ids = record.connection!.selectedIds;
      if (!ids.length || ids.length > 50)
        throw new MeetingError("calendar_unavailable");
      const busy = await googleBusy(tokens.accessToken, ids, window, signal);
      return {
        busy,
        manual: null,
        revision: record.revision,
        source: "google",
      };
    } catch (error) {
      if (error instanceof MeetingError) throw error;
      throw new MeetingError("calendar_unavailable");
    }
  }
  private validateCoverage(value: MeetingRecord, coverages: Coverage[]) {
    this.current(value);
    value.participants.forEach((id, index) => {
      if (
        !value.consents[id] ||
        this.calendar(id).revision !== coverages[index].revision
      )
        throw new MeetingError("availability_changed");
    });
  }
  private permitted(
    userId: string,
    coverage: Coverage,
    slot: MeetingSlot,
    meetingId: string,
  ) {
    const context = this.context(userId).context;
    const start = Date.parse(slot.start),
      end = Date.parse(slot.end);
    if (start <= Date.now()) return false;
    const overlaps = (item: MeetingSlot) =>
      start < Date.parse(item.end) && end > Date.parse(item.start);
    if (coverage.busy.some(overlaps)) return false;
    if (
      coverage.manual &&
      !coverage.manual.some(
        (item) =>
          start >= Date.parse(item.start) && end <= Date.parse(item.end),
      )
    )
      return false;
    if (
      context.availability.status === "provided" &&
      !context.availability.windows.some((item) => {
        const window = windowInstants(item);
        return start >= window.start && end <= window.end;
      })
    )
      return false;
    if (
      context.commitments.items.some((item) => {
        const window = windowInstants(item);
        return start < window.end && end > window.start;
      })
    )
      return false;
    const local = this.db
      .prepare(
        "SELECT state_json FROM meetings WHERE id <> ? AND (first_user_id = ? OR second_user_id = ?)",
      )
      .all(meetingId, userId, userId) as { state_json: string }[];
    return !local.some((row) => {
      const other = JSON.parse(row.state_json) as MeetingRecord;
      const chosen = other.options.find(
        (option) => option.id === other.selectedOptionId,
      );
      return other.status === "confirmed" && chosen && overlaps(chosen);
    });
  }
  private async availability(value: MeetingRecord) {
    this.current(value);
    if (!value.participants.every((id) => value.consents[id]))
      throw new MeetingError("approval_required");
    const window = this.bounds(value);
    const coverages = await Promise.all(
      value.participants.map((id) =>
        this.coverage(id, value.consents[id], window),
      ),
    );
    const options: MeetingOption[] = [];
    for (
      let date = Temporal.PlainDate.from(window.startDate);
      Temporal.PlainDate.compare(date, window.endDate) <= 0;
      date = date.add({ days: 1 })
    ) {
      if (date.dayOfWeek > 5) continue;
      const bounds = windowInstants({
        date: date.toString(),
        start: "09:00",
        end: "18:00",
      });
      for (
        let start = bounds.start;
        start + HALF_HOUR <= bounds.end;
        start += HALF_HOUR
      ) {
        const slot = {
          start: new Date(start).toISOString(),
          end: new Date(start + HALF_HOUR).toISOString(),
        };
        if (
          !value.participants.every((id, index) =>
            this.permitted(id, coverages[index], slot, value.id),
          )
        )
          continue;
        options.push({
          ...slot,
          id: createHash("sha256")
            .update(`${value.id}:${slot.start}:${slot.end}`)
            .digest("hex")
            .slice(0, 24),
        });
        if (options.length === 3) break;
      }
      if (options.length === 3) break;
    }
    const source =
      coverages[0].source === coverages[1].source
        ? coverages[0].source
        : ("mixed" as const);
    return { coverages, options, source };
  }
  async approve(
    actorId: string,
    raw: { meetingId: string; revision: number; optionId: string },
  ): Promise<MeetingView> {
    const input = meetingApprovalSchema.parse(raw);
    const existing = this.read(actorId, input.meetingId);
    let value: MeetingRecord;
    if (
      ["options_ready", "confirmed"].includes(existing.status) &&
      existing.selectedOptionId === input.optionId &&
      existing.approvals[actorId] === input.optionId
    ) {
      this.current(existing);
      if (
        existing.status === "confirmed" ||
        !existing.participants.every(
          (id) => existing.approvals[id] === input.optionId,
        )
      )
        return this.view(actorId, existing);
      // Both approvals may have survived a restart before the final check finished.
      value = existing;
    } else
      value = this.db
        .transaction(() => {
          const current = this.writable(
            actorId,
            input.meetingId,
            input.revision,
          );
          if (
            current.status !== "options_ready" ||
            !current.options.some((option) => option.id === input.optionId)
          )
            throw new MeetingError("invalid_option");
          if (!current.location) throw new MeetingError("location_required");
          const approvals =
            current.selectedOptionId &&
            current.selectedOptionId !== input.optionId
              ? {}
              : current.approvals;
          return this.save(
            {
              ...current,
              selectedOptionId: input.optionId,
              approvals: { ...approvals, [actorId]: input.optionId },
            },
            current.revision,
          );
        })
        .immediate();
    if (
      !value.participants.every((id) => value.approvals[id] === input.optionId)
    )
      return this.view(actorId, value);
    try {
      const available = await this.availability(value);
      const selected = value.options.find(
        (option) => option.id === input.optionId,
      )!;
      const confirmed = this.db
        .transaction(() => {
          const current = this.writable(actorId, value.id, value.revision);
          this.validateCoverage(current, available.coverages);
          if (
            !value.participants.every((id, index) =>
              this.permitted(
                id,
                available.coverages[index],
                selected,
                value.id,
              ),
            )
          )
            throw new MeetingError("availability_changed");
          return this.save(
            {
              ...current,
              status: "confirmed",
              checkedAt: new Date().toISOString(),
              availabilitySource: available.source,
              error: null,
            },
            current.revision,
          );
        })
        .immediate();
      return this.view(actorId, confirmed);
    } catch (error) {
      this.recordFailure(actorId, value, error);
      throw error;
    }
  }
  withdraw(
    actorId: string,
    raw: { meetingId: string; revision: number },
  ): MeetingView {
    const input = meetingRevisionSchema.parse(raw);
    const result = this.db
      .transaction(() => {
        const value = this.read(actorId, input.meetingId);
        if (value.status === "withdrawn") return value;
        if (value.revision !== input.revision)
          throw new MeetingError("meeting_changed");
        return this.save(
          {
            ...value,
            status: "withdrawn",
            consents: {},
            approvals: {},
            options: [],
            selectedOptionId: null,
            error: null,
          },
          value.revision,
        );
      })
      .immediate();
    return this.view(actorId, result);
  }
  exportICS(actorId: string, meetingId: string): string {
    const value = this.read(actorId, meetingId);
    this.current(value);
    if (
      value.status !== "confirmed" ||
      !value.participants.every(
        (id) => value.approvals[id] === value.selectedOptionId,
      )
    )
      throw new MeetingError("approval_required");
    const slot = value.options.find(
      (option) => option.id === value.selectedOptionId,
    );
    if (!slot) throw new MeetingError("invalid_option");
    const escape = (text: string) =>
      text
        .replace(/\\/g, "\\\\")
        .replace(/\r\n|\r|\n/g, "\\n")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,");
    const timestamp = (date: string) =>
      new Date(date)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
    const fold = (line: string) => {
      const parts: string[] = [];
      let part = "";
      for (const char of line) {
        if (Buffer.byteLength(part + char) > 73) {
          parts.push(part);
          part = ` ${char}`;
        } else part += char;
      }
      parts.push(part);
      return parts.join("\r\n");
    };
    return (
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Sidekick//Meeting agreement//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:${value.id}@sidekick.local`,
        `DTSTAMP:${timestamp(value.createdAt)}`,
        `DTSTART:${timestamp(slot.start)}`,
        `DTEND:${timestamp(slot.end)}`,
        `SUMMARY:${escape(value.purpose)}`,
        `LOCATION:${escape(value.location ?? "")}`,
        `DESCRIPTION:${escape("Both participants confirmed this time in Sidekick. This file is an export; no calendar invitation was sent or synced.")}`,
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
      ]
        .map(fold)
        .join("\r\n") + "\r\n"
    );
  }
}
