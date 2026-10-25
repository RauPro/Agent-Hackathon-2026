import { createHash, randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type { AsyncDatabase } from "./database";
import {
  calendarWindow,
  type CalendarConnection,
  type CalendarRecord,
  type CalendarWindow,
  type MeetingCalendarPublication,
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
  meetingPreferencesSchema,
  meetingLocationSchema,
  meetingRevisionSchema,
  proposeMeetingSchema,
  type MeetingActivityEntry,
  type MeetingOption,
  type MeetingSlot,
  type MeetingStatus,
  type MeetingView,
} from "@/lib/domain/meetings";
import type { SharedProfile } from "@/lib/domain/network";
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
import {
  inspectPublishedMeeting,
  prepareMeetingCalendar,
  publishApprovedMeeting,
} from "./meeting-calendar-service";

const HALF_HOUR = 30 * 60 * 1000;
const liveStatuses: MeetingStatus[] = [
  "awaiting_permission",
  "options_ready",
  "needs_user_input",
];
type Consent = {
  at: string;
  manualSlots: MeetingSlot[] | null;
  preferredWindows?: MeetingSlot[];
};
type MeetingRecord = {
  id: string;
  revision: number;
  initiatorId: string;
  participants: [string, string];
  names: Record<string, string>;
  purpose: string;
  location: string | null;
  modality?: "in_person" | "online";
  agentNegotiation?: boolean;
  sharedArea?: string | null;
  sharedEvent?: MeetingView["sharedEvent"];
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
  activity?: MeetingActivityEntry[];
  expiresAt: string;
  error: string | null;
  calendarPublication?: MeetingCalendarPublication | null;
};
type NetworkAccess = {
  db: AsyncDatabase;
  profile(userId: string): Promise<ContextState>;
  isConnected(a: string, b: string): Promise<boolean>;
  blocked(a: string, b: string): Promise<boolean>;
  relationshipRevision(a: string, b: string): Promise<number>;
  project(viewerId: string, targetId: string): Promise<SharedProfile>;
};
type Coverage = {
  busy: MeetingSlot[];
  manual: MeetingSlot[] | null;
  revision: number;
  source: "google" | "manual";
  preferredWindows?: MeetingSlot[];
};
type CalendarOwner = CalendarRecord & { owner: string };
type SchedulingConstraints = {
  context: UserContext;
  confirmedSlots: MeetingSlot[];
};

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
  event_unavailable: [
    403,
    "Choose an event that both people have shared with each other.",
  ],
  calendar_published: [
    409,
    "This meeting has a calendar invitation. Open that event to cancel or change it.",
  ],
  publishing: [
    409,
    "This calendar invitation is being prepared. Try again shortly.",
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
  private db: AsyncDatabase;
  constructor(private store: ContextStore) {
    this.network = store.network;
    this.db = this.network.db;
  }

  private async requireUser(userId: string) {
    if (
      !(await this.db.prepare("SELECT id FROM users WHERE id = ?").get(userId))
    )
      throw new MeetingError("not_found");
  }
  private async relationship(a: string, b: string) {
    if (
      a === b ||
      !(await this.network.isConnected(a, b)) ||
      (await this.network.blocked(a, b))
    )
      throw new MeetingError("not_connected");
  }
  private async context(userId: string) {
    const profile = await this.network.profile(userId);
    if (!profile.context || !profile.confirmedAt)
      throw new MeetingError("profile_required");
    return profile as ContextState & { context: UserContext };
  }
  private async read(actorId: string, meetingId: string) {
    const row = (await this.db
      .prepare(
        "SELECT state_json FROM meetings WHERE id = ? AND (first_user_id = ? OR second_user_id = ?)",
      )
      .get(meetingId, actorId, actorId)) as { state_json: string } | undefined;
    if (!row) throw new MeetingError("not_found");
    return JSON.parse(row.state_json) as MeetingRecord;
  }
  private async save(value: MeetingRecord, expected: number) {
    const next = { ...value, revision: expected + 1 };
    const result = await this.db
      .prepare(
        "UPDATE meetings SET revision = ?, state_json = ? WHERE id = ? AND revision = ?",
      )
      .run(next.revision, JSON.stringify(next), value.id, expected);
    if (result.changes !== 1) throw new MeetingError("meeting_changed");
    return next;
  }
  private activity(value: MeetingRecord): MeetingActivityEntry[] {
    // Older records only have a reliable proposal timestamp.
    return (
      value.activity ?? [
        {
          id: `${value.id}:proposed`,
          at: value.createdAt,
          kind: "proposed",
          actorUserId: value.initiatorId,
        },
      ]
    );
  }
  private withActivity(
    value: MeetingRecord,
    entry: Omit<MeetingActivityEntry, "id" | "at">,
  ): MeetingRecord {
    const activity = this.activity(value);
    const previous = activity.at(-1);
    // Repeated failed checks describe the same unresolved state.
    if (
      ["availability_failed", "no_common_time", "escalated"].includes(
        entry.kind,
      ) &&
      previous?.kind === entry.kind
    )
      return { ...value, activity };
    return {
      ...value,
      activity: [
        ...activity,
        { ...entry, id: randomUUID(), at: new Date().toISOString() },
      ],
    };
  }
  private async current(value: MeetingRecord) {
    await this.relationship(...value.participants);
    if (
      (await this.network.relationshipRevision(...value.participants)) !==
      value.relationshipRevision
    )
      throw new MeetingError("meeting_changed");
    if (
      value.status !== "confirmed" &&
      Date.parse(value.expiresAt) <= Date.now()
    )
      throw new MeetingError("meeting_expired");
    for (const id of value.participants) {
      if ((await this.context(id)).revision !== value.contextRevisions[id])
        throw new MeetingError("meeting_changed");
    }
    if (value.sharedEvent)
      await this.sharedEvent(value.participants, value.sharedEvent.id);
  }
  private async sharedEvent(participants: [string, string], eventId?: string) {
    const [a, b] = await Promise.all([
      this.network.project(participants[1], participants[0]),
      this.network.project(participants[0], participants[1]),
    ]);
    const event = a.events
      ?.filter((item) => !eventId || item.id === eventId)
      .sort((first, second) =>
        (first.start ?? "").localeCompare(second.start ?? ""),
      )
      .find((item) => {
        if (
          !item.start ||
          !item.end ||
          (!eventId && Date.parse(item.end) <= Date.now()) ||
          item.dateStatus === "unconfirmed_year"
        )
          return false;
        const keys = new Set([item.id, ...(item.canonicalKeys ?? [])]);
        return b.events?.some(
          (peer) =>
            peer.start &&
            peer.end &&
            peer.dateStatus !== "unconfirmed_year" &&
            [peer.id, ...(peer.canonicalKeys ?? [])].some((key) =>
              keys.has(key),
            ),
        );
      });
    if (!event?.start || !event.end) {
      if (eventId) throw new MeetingError("event_unavailable");
      return null;
    }
    return {
      id: event.id,
      title: event.title,
      start: event.start,
      end: event.end,
    };
  }
  private async writable(actorId: string, meetingId: string, revision: number) {
    const value = await this.read(actorId, meetingId);
    if (value.revision !== revision) throw new MeetingError("meeting_changed");
    await this.current(value);
    if (!liveStatuses.includes(value.status))
      throw new MeetingError("meeting_closed");
    return value;
  }
  private async calendar(userId: string): Promise<CalendarOwner> {
    const owner = (await this.db
      .prepare("SELECT profile_id FROM users WHERE id = ?")
      .get(userId)) as { profile_id: string } | undefined;
    if (!owner) throw new MeetingError("not_found");
    const record = (await this.db
      .prepare(
        "SELECT revision, connection_json FROM calendar_connections WHERE session_id = ?",
      )
      .get(owner.profile_id)) as
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
  private async saveCalendar(
    record: CalendarOwner,
    connection: CalendarConnection,
  ) {
    const result = await this.db
      .prepare(
        "UPDATE calendar_connections SET revision = revision + 1, connection_json = ? WHERE session_id = ? AND revision = ?",
      )
      .run(JSON.stringify(connection), record.owner, record.revision);
    if (result.changes !== 1) throw new MeetingError("availability_changed");
    return { ...record, revision: record.revision + 1, connection };
  }
  private async view(
    actorId: string,
    record: MeetingRecord,
  ): Promise<MeetingView> {
    let value = record;
    if (liveStatuses.includes(value.status) || value.status === "confirmed") {
      try {
        await this.current(value);
      } catch (error) {
        if (!(error instanceof MeetingError)) throw error;
        value = await this.db
          .transaction(async () => {
            const latest = await this.read(actorId, value.id);
            if (
              !liveStatuses.includes(latest.status) &&
              latest.status !== "confirmed"
            )
              return latest;
            try {
              await this.current(latest);
              return latest;
            } catch (failure) {
              if (!(failure instanceof MeetingError)) throw failure;
              const status =
                failure.code === "meeting_expired" ? "expired" : "stale";
              return this.save(
                this.withActivity(
                  {
                    ...latest,
                    status,
                    options: [],
                    approvals: {},
                    selectedOptionId: null,
                    error:
                      status === "expired"
                        ? "This proposal expired. Start a new one."
                        : "The profile or relationship changed. Start a new proposal.",
                  },
                  { kind: status },
                ),
                latest.revision,
              );
            }
          })
          .immediate();
      }
    }
    const calendar = await this.calendar(actorId);
    const active = liveStatuses.includes(value.status);
    const consent = value.consents[actorId];
    const other = value.participants.find((id) => id !== actorId)!;
    let nextAction: MeetingView["nextAction"] = null;
    if (active && !consent) {
      nextAction = calendar.connection
        ? {
            kind: "authorize_availability",
            prompt: `${value.names[other]} would like to meet. May I check your calendar and share possible meeting times with their agent?`,
          }
        : {
            kind: "provide_availability",
            prompt: `${value.names[other]} would like to meet. What day and time would work for you?`,
          };
    } else if (active && value.status === "needs_user_input") {
      nextAction = {
        kind: "suggest_times",
        prompt: `I could not find a common time with ${value.names[other]}. What other day or time would work for you? I will check it with their agent.`,
      };
    } else if (active && value.error) {
      nextAction = {
        kind: "reconnect_calendar",
        prompt:
          "I could not check availability. Please reconnect your calendar or try again.",
      };
    }
    const ownContext = (await this.network.profile(actorId)).context;
    const publication = value.calendarPublication;
    return {
      id: value.id,
      createdAt: value.createdAt,
      activity: this.activity(value).map((entry) => {
        if (!active && value.status !== "confirmed") {
          const metadata = { ...entry };
          delete metadata.optionId;
          delete metadata.slots;
          return metadata;
        }
        if (
          !entry.optionId ||
          value.options.some((option) => option.id === entry.optionId)
        )
          return entry;
        const metadata = { ...entry };
        delete metadata.optionId;
        return metadata;
      }),
      revision: value.revision,
      initiatorId: value.initiatorId,
      participants: value.participants.map((id) => ({
        userId: id,
        name: value.names[id],
      })),
      purpose: value.purpose,
      location: value.location,
      modality: value.modality ?? "in_person",
      sharedArea: value.sharedArea ?? null,
      suggestedArea: ownContext?.stay?.area ?? null,
      ownPreferredWindows: consent?.preferredWindows ?? [],
      sharedEvent:
        active || value.status === "confirmed"
          ? (value.sharedEvent ?? null)
          : null,
      nextAction,
      status: value.status,
      durationMinutes: 30,
      timezone: SF_TIMEZONE,
      options: value.options,
      selectedOptionId: value.selectedOptionId,
      consentedUserIds: Object.keys(value.consents),
      approvedUserIds: Object.keys(value.approvals),
      manualAvailabilityNeeded: !calendar.connection,
      availabilitySource: value.availabilitySource,
      checkedAt: value.checkedAt,
      expiresAt: value.expiresAt,
      calendarStatus:
        value.status === "confirmed" ? "export_available" : "not_ready",
      calendarPublication: publication
        ? {
            status: publication.status,
            organizerUserId: publication.organizerUserId,
            eventId: publication.eventId,
            eventUrl: publication.eventUrl,
            meetUrl: publication.meetUrl,
            error: publication.error,
            updatedAt: publication.updatedAt,
          }
        : null,
      error: value.error,
    };
  }
  async list(actorId: string): Promise<MeetingView[]> {
    await this.requireUser(actorId);
    const rows = (await this.db
      .prepare(
        "SELECT state_json FROM meetings WHERE first_user_id = ? OR second_user_id = ? ORDER BY rowid DESC LIMIT 50",
      )
      .all(actorId, actorId)) as { state_json: string }[];
    return Promise.all(
      rows.map((row) =>
        this.view(actorId, JSON.parse(row.state_json) as MeetingRecord),
      ),
    );
  }
  async propose(
    actorId: string,
    raw: {
      toUserId: string;
      requestId: string;
      purpose: string;
      location?: string;
      modality?: "in_person" | "online";
      sharedArea?: string;
      eventId?: string;
      authorizeAvailability?: boolean;
    },
  ): Promise<MeetingView> {
    const input = proposeMeetingSchema.parse(raw);
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const result = await this.db
      .transaction(async () => {
        await this.requireUser(actorId);
        const previous = (await this.db
          .prepare(
            "SELECT payload_hash, state_json FROM meetings WHERE initiator_id = ? AND request_id = ?",
          )
          .get(actorId, input.requestId)) as
          | { payload_hash: string; state_json: string }
          | undefined;
        if (previous) {
          if (previous.payload_hash !== payloadHash)
            throw new MeetingError("request_conflict");
          return JSON.parse(previous.state_json) as MeetingRecord;
        }
        await this.relationship(actorId, input.toUserId);
        const count = (await this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM meetings WHERE initiator_id = ? AND json_extract(state_json, '$.createdAt') > ?",
          )
          .get(actorId, new Date(Date.now() - 86400000).toISOString())) as {
          n: number;
        };
        if (count.n >= 10) throw new MeetingError("rate_limit");
        const participants: [string, string] = [actorId, input.toUserId];
        const profiles = await Promise.all(
          participants.map((id) => this.context(id)),
        );
        let value: MeetingRecord = {
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
          location:
            input.modality === "online"
              ? "Google Meet"
              : (input.location ?? null),
          modality: input.modality ?? "in_person",
          agentNegotiation: input.authorizeAvailability === true,
          sharedArea: input.sharedArea ?? null,
          sharedEvent: await this.sharedEvent(participants, input.eventId),
          status: "awaiting_permission",
          contextRevisions: Object.fromEntries(
            participants.map((id, index) => [id, profiles[index].revision]),
          ),
          relationshipRevision: await this.network.relationshipRevision(
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
        value = { ...value, activity: this.activity(value) };
        await this.db
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
    if (
      input.authorizeAvailability &&
      !result.consents[actorId] &&
      (await this.calendar(actorId)).connection
    )
      return this.optIn(actorId, {
        meetingId: result.id,
        revision: result.revision,
      });
    return await this.view(actorId, result);
  }
  async optIn(
    actorId: string,
    raw: { meetingId: string; revision: number; manualSlots?: MeetingSlot[] },
  ): Promise<MeetingView> {
    const input = meetingOptInSchema.parse(raw);
    const value = await this.db
      .transaction(async () => {
        const current = await this.read(actorId, input.meetingId);
        await this.current(current);
        const calendar = await this.calendar(actorId);
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
        if (
          current.consents[actorId] &&
          JSON.stringify(current.consents[actorId].manualSlots) ===
            JSON.stringify(manual) &&
          (liveStatuses.includes(current.status) ||
            current.status === "confirmed")
        )
          return current;
        await this.writable(actorId, input.meetingId, input.revision);
        if (manual) {
          const trip = (await this.context(actorId)).context.trip;
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
        return await this.save(
          this.withActivity(
            {
              ...current,
              status: "awaiting_permission",
              consents: {
                ...current.consents,
                [actorId]: {
                  at: new Date().toISOString(),
                  manualSlots: manual,
                  preferredWindows: current.consents[actorId]?.preferredWindows,
                },
              },
              options: [],
              selectedOptionId: null,
              approvals: {},
              error: null,
            },
            { kind: "availability_consented", actorUserId: actorId },
          ),
          current.revision,
        );
      })
      .immediate();
    if (
      value.status === "options_ready" ||
      value.status === "confirmed" ||
      value.status === "needs_user_input"
    )
      return await this.view(actorId, value);
    return this.negotiate(actorId, value);
  }
  async suggestTimes(
    actorId: string,
    raw: {
      meetingId: string;
      revision: number;
      preferredWindows: MeetingSlot[];
    },
  ): Promise<MeetingView> {
    const input = meetingPreferencesSchema.parse(raw);
    const value = await this.db
      .transaction(async () => {
        const current = await this.read(actorId, input.meetingId);
        await this.current(current);
        const existing = current.consents[actorId];
        if (
          JSON.stringify(existing?.preferredWindows) ===
            JSON.stringify(input.preferredWindows) &&
          liveStatuses.includes(current.status)
        )
          return current;
        await this.writable(actorId, current.id, input.revision);
        const trip = (await this.context(actorId)).context.trip;
        const limits = calendarWindow(trip.start, trip.end)!;
        if (
          input.preferredWindows.some(
            (slot) =>
              Date.parse(slot.start) < Date.parse(limits.timeMin) ||
              Date.parse(slot.end) > Date.parse(limits.timeMax) ||
              Date.parse(slot.end) <= Date.now(),
          )
        )
          throw new MeetingError("invalid_manual_slots");
        const connected = !!(await this.calendar(actorId)).connection;
        return this.save(
          this.withActivity(
            {
              ...current,
              status: "awaiting_permission",
              consents: {
                ...current.consents,
                [actorId]: {
                  at: new Date().toISOString(),
                  manualSlots: connected ? null : input.preferredWindows,
                  preferredWindows: input.preferredWindows,
                },
              },
              options: [],
              approvals: {},
              selectedOptionId: null,
              error: null,
            },
            { kind: "preferences_updated", actorUserId: actorId },
          ),
          current.revision,
        );
      })
      .immediate();
    if (value.status === "options_ready" || value.status === "needs_user_input")
      return this.view(actorId, value);
    return this.negotiate(actorId, value);
  }
  private async negotiate(
    actorId: string,
    value: MeetingRecord,
  ): Promise<MeetingView> {
    const bothConsented = value.participants.every((id) => value.consents[id]);
    if (!bothConsented && !value.consents[actorId])
      return this.view(actorId, value);
    if (!bothConsented && !value.agentNegotiation)
      return this.view(actorId, value);
    if (
      !bothConsented &&
      !value.error &&
      this.activity(value).at(-1)?.kind === "agent_slots_proposed"
    )
      return this.view(actorId, value);
    try {
      const available = bothConsented ? await this.availability(value) : null;
      // A unilateral offer reads only the consenting owner's calendar.
      const ownCoverage = !bothConsented
        ? await this.coverage(
            actorId,
            value.consents[actorId],
            await this.bounds(value),
          )
        : null;
      const ownConstraints = ownCoverage
        ? await this.constraints(actorId, value.id)
        : null;
      const ownOptions =
        ownCoverage && ownConstraints
          ? this.candidates(value, await this.bounds(value))
              .filter((slot) =>
                this.permitted(ownCoverage, slot, ownConstraints),
              )
              .slice(0, 3)
          : [];
      const updated = await this.db
        .transaction(async () => {
          const current = await this.writable(
            actorId,
            value.id,
            value.revision,
          );
          if (available)
            await this.validateCoverage(current, available.coverages);
          else if (
            ownCoverage &&
            (await this.calendar(actorId)).revision !== ownCoverage.revision
          )
            throw new MeetingError("availability_changed");
          if (!available) {
            if (
              this.activity(current).some(
                (entry) =>
                  entry.kind === "agent_slots_proposed" &&
                  entry.actorUserId === actorId,
              ) &&
              !current.error
            )
              return current;
            return this.save(
              this.withActivity(
                { ...current, error: null },
                {
                  kind: "agent_slots_proposed",
                  actorUserId: actorId,
                  optionCount: ownOptions.length,
                  slots: ownOptions,
                },
              ),
              current.revision,
            );
          }
          let next = current;
          const lastProposal = this.activity(current)
            .filter((entry) => entry.kind === "agent_slots_proposed")
            .at(-1);
          if (
            !lastProposal ||
            !lastProposal.slots?.some((slot) =>
              available.offered.some(
                (offered) =>
                  offered.start === slot.start && offered.end === slot.end,
              ),
            )
          ) {
            next = this.withActivity(next, {
              kind: "agent_slots_proposed",
              actorUserId: value.initiatorId,
              optionCount: available.offered.length,
              slots: available.offered,
            });
          }
          const recipient = current.participants.find(
            (id) => id !== current.initiatorId,
          )!;
          next = this.withActivity(next, {
            kind: "agent_slots_checked",
            actorUserId: recipient,
            optionCount: available.accepted.length,
            slots: available.accepted,
          });
          if (!available.accepted.length && available.options.length) {
            next = this.withActivity(next, {
              kind: "agent_counterproposed",
              actorUserId: recipient,
              optionCount: available.options.length,
              slots: available.options,
            });
            next = this.withActivity(next, {
              kind: "agent_slots_checked",
              actorUserId: current.initiatorId,
              optionCount: available.options.length,
              slots: available.options,
            });
          }
          if (!available.options.length) {
            next = this.withActivity(
              {
                ...next,
                status: "needs_user_input",
                options: [],
                approvals: {},
                selectedOptionId: null,
                availabilitySource: available.source,
                checkedAt: new Date().toISOString(),
                error:
                  "No common time was found. Tell your agent another day or time in the main chat.",
              },
              { kind: "no_common_time" },
            );
            next = this.withActivity(next, { kind: "escalated" });
          } else {
            next = this.withActivity(
              {
                ...next,
                status: "options_ready",
                options: available.options,
                availabilitySource: available.source,
                checkedAt: new Date().toISOString(),
                error: null,
              },
              { kind: "options_ready", optionCount: available.options.length },
            );
          }
          return this.save(next, current.revision);
        })
        .immediate();
      return this.view(actorId, updated);
    } catch (error) {
      await this.recordFailure(actorId, value, error);
      if (error instanceof MeetingError && error.code === "no_slots")
        return this.view(actorId, await this.read(actorId, value.id));
      throw error;
    }
  }
  private async recordFailure(
    actorId: string,
    value: MeetingRecord,
    error: unknown,
  ) {
    await this.db
      .transaction(async () => {
        const current = await this.read(actorId, value.id);
        if (current.revision !== value.revision) return;
        await this.save(
          this.withActivity(
            {
              ...current,
              status:
                error instanceof MeetingError && error.code === "no_slots"
                  ? "needs_user_input"
                  : "awaiting_permission",
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
            {
              kind:
                error instanceof MeetingError && error.code === "no_slots"
                  ? "escalated"
                  : "availability_failed",
            },
          ),
          current.revision,
        );
      })
      .immediate();
  }
  private async bounds(value: MeetingRecord): Promise<CalendarWindow> {
    const profiles = await Promise.all(
      value.participants.map((id) => this.context(id)),
    );
    const [a, b] = profiles.map((profile) => profile.context.trip);
    const today = Temporal.Now.plainDateISO(SF_TIMEZONE).toString();
    const preferredStarts = value.participants.flatMap((id) => {
      const first = value.consents[id]?.preferredWindows
        ?.map((slot) => slot.start)
        .sort()[0];
      return first
        ? [
            Temporal.Instant.from(first)
              .toZonedDateTimeISO(SF_TIMEZONE)
              .toPlainDate()
              .toString(),
          ]
        : [];
    });
    const eventDate =
      !preferredStarts.length && value.sharedEvent
        ? [
            Temporal.Instant.from(value.sharedEvent.start)
              .toZonedDateTimeISO(SF_TIMEZONE)
              .toPlainDate()
              .toString(),
          ]
        : [];
    const start = [a.start, b.start, today, ...preferredStarts, ...eventDate]
      .sort()
      .at(-1)!;
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
    let record = await this.calendar(userId);
    if (!record.connection) {
      if (!consent.manualSlots?.length)
        throw new MeetingError("manual_required");
      return {
        busy: [],
        manual: consent.manualSlots,
        revision: record.revision,
        source: "manual",
        preferredWindows: consent.preferredWindows,
      };
    }
    if (consent.manualSlots) throw new MeetingError("availability_changed");
    if (!googleCalendarConfig()) throw new MeetingError("calendar_unavailable");
    const leaseKey = `calendar:${record.owner}`;
    const lease = await this.db.acquireLease(leaseKey, 35_000);
    if (!lease) throw new MeetingError("calendar_unavailable");
    try {
      record = await this.calendar(userId);
      if (!record.connection) throw new MeetingError("availability_changed");
      let tokens = tokenDataSchema.parse(
        openCalendarData(record.connection.encryptedTokens, record.owner),
      );
      if (!hasCalendarScopes(tokens.scopes))
        throw new CalendarError("needs_reconnect");
      const signal = AbortSignal.timeout(25000);
      if (tokens.expiresAt < Date.now() + 60000) {
        tokens = await refreshGoogleTokens(tokens, signal);
        record = await this.saveCalendar(record, {
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
        preferredWindows: consent.preferredWindows,
      };
    } catch (error) {
      if (error instanceof MeetingError) throw error;
      throw new MeetingError("calendar_unavailable");
    } finally {
      await this.db.releaseLease(leaseKey, lease);
    }
  }
  private async validateCoverage(value: MeetingRecord, coverages: Coverage[]) {
    await this.current(value);
    for (const [index, id] of value.participants.entries()) {
      if (
        !value.consents[id] ||
        (await this.calendar(id)).revision !== coverages[index].revision
      )
        throw new MeetingError("availability_changed");
    }
  }
  private async constraints(
    userId: string,
    meetingId: string,
  ): Promise<SchedulingConstraints> {
    const context = (await this.context(userId)).context;
    const local = (await this.db
      .prepare(
        "SELECT state_json FROM meetings WHERE id <> ? AND (first_user_id = ? OR second_user_id = ?)",
      )
      .all(meetingId, userId, userId)) as { state_json: string }[];
    const confirmedSlots = local.flatMap((row) => {
      const other = JSON.parse(row.state_json) as MeetingRecord;
      const chosen = other.options.find(
        (option) => option.id === other.selectedOptionId,
      );
      return other.status === "confirmed" && chosen ? [chosen] : [];
    });
    return { context, confirmedSlots };
  }
  private permitted(
    coverage: Coverage,
    slot: MeetingSlot,
    constraints: SchedulingConstraints,
  ) {
    const { context, confirmedSlots } = constraints;
    const start = Date.parse(slot.start),
      end = Date.parse(slot.end);
    if (start <= Date.now()) return false;
    const overlaps = (item: MeetingSlot) =>
      start < Date.parse(item.end) && end > Date.parse(item.start);
    if (coverage.busy.some(overlaps)) return false;
    if (
      coverage.preferredWindows?.length &&
      !coverage.preferredWindows.some(
        (item) =>
          start >= Date.parse(item.start) && end <= Date.parse(item.end),
      )
    )
      return false;
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
    return !confirmedSlots.some(overlaps);
  }
  private candidates(
    value: MeetingRecord,
    window: CalendarWindow,
  ): MeetingOption[] {
    const candidates: MeetingOption[] = [];
    for (
      let date = Temporal.PlainDate.from(window.startDate);
      Temporal.PlainDate.compare(date, window.endDate) <= 0;
      date = date.add({ days: 1 })
    ) {
      // Explicitly requested windows and a shared event may include weekends.
      if (
        date.dayOfWeek > 5 &&
        !value.sharedEvent &&
        !value.participants.some(
          (id) => value.consents[id]?.preferredWindows?.length,
        )
      )
        continue;
      const explicitWindows = value.participants.some(
        (id) => value.consents[id]?.preferredWindows?.length,
      );
      const limits = explicitWindows
        ? {
            start: Number(date.toZonedDateTime(SF_TIMEZONE).epochMilliseconds),
            end: Number(
              date.add({ days: 1 }).toZonedDateTime(SF_TIMEZONE)
                .epochMilliseconds,
            ),
          }
        : windowInstants({
            date: date.toString(),
            start: "09:00",
            end: "18:00",
          });
      for (
        let start = limits.start;
        start + HALF_HOUR <= limits.end;
        start += HALF_HOUR
      ) {
        const slot = {
          start: new Date(start).toISOString(),
          end: new Date(start + HALF_HOUR).toISOString(),
        };
        if (
          value.sharedEvent &&
          start < Date.parse(value.sharedEvent.end) &&
          start + HALF_HOUR > Date.parse(value.sharedEvent.start)
        )
          continue;
        candidates.push({
          ...slot,
          id: createHash("sha256")
            .update(`${value.id}:${slot.start}:${slot.end}`)
            .digest("hex")
            .slice(0, 24),
        });
      }
    }
    if (value.sharedEvent) {
      const end = Date.parse(value.sharedEvent.end);
      // Prefer a half-hour buffer after the shared event, without claiming travel time.
      const distance = (slot: MeetingSlot) => {
        const gap = Date.parse(slot.start) - end;
        return gap >= HALF_HOUR && gap <= 4 * 3600000
          ? gap
          : 10000000000 + Math.abs(gap);
      };
      candidates.sort((a, b) => distance(a) - distance(b));
    }
    return candidates;
  }
  private async availability(value: MeetingRecord) {
    await this.current(value);
    if (!value.participants.every((id) => value.consents[id]))
      throw new MeetingError("approval_required");
    const window = await this.bounds(value);
    const results = await Promise.allSettled(
      value.participants.map((id) =>
        this.coverage(id, value.consents[id], window),
      ),
    );
    // Finish both reads and release their leases before handling a failure.
    const coverages = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const constraints = await Promise.all(
      value.participants.map((id) => this.constraints(id, value.id)),
    );
    const candidates = this.candidates(value, window);
    const own = candidates.filter((slot) =>
      this.permitted(coverages[0], slot, constraints[0]),
    );
    const offered = own.slice(0, 3);
    const accepted = offered.filter((slot) =>
      this.permitted(coverages[1], slot, constraints[1]),
    );
    const common = own.filter((slot) =>
      this.permitted(coverages[1], slot, constraints[1]),
    );
    const options = accepted.length ? accepted : common.slice(0, 3);
    const source =
      coverages[0].source === coverages[1].source
        ? coverages[0].source
        : ("mixed" as const);
    return { coverages, options, source, offered, accepted };
  }
  async approve(
    actorId: string,
    raw: { meetingId: string; revision: number; optionId: string },
  ): Promise<MeetingView> {
    const input = meetingApprovalSchema.parse(raw);
    const existing = await this.read(actorId, input.meetingId);
    let value: MeetingRecord;
    if (
      ["options_ready", "confirmed"].includes(existing.status) &&
      existing.selectedOptionId === input.optionId &&
      existing.approvals[actorId] === input.optionId
    ) {
      await this.current(existing);
      if (
        existing.status === "confirmed" ||
        !existing.participants.every(
          (id) => existing.approvals[id] === input.optionId,
        )
      )
        return await this.view(actorId, existing);
      // Both approvals may have survived a restart before the final check finished.
      value = existing;
    } else
      value = await this.db
        .transaction(async () => {
          const current = await this.writable(
            actorId,
            input.meetingId,
            input.revision,
          );
          if (
            current.status !== "options_ready" ||
            !current.options.some((option) => option.id === input.optionId)
          )
            throw new MeetingError("invalid_option");
          if (!current.location && current.modality !== "online")
            throw new MeetingError("location_required");
          const approvals =
            current.selectedOptionId &&
            current.selectedOptionId !== input.optionId
              ? {}
              : current.approvals;
          return await this.save(
            this.withActivity(
              {
                ...current,
                selectedOptionId: input.optionId,
                approvals: { ...approvals, [actorId]: input.optionId },
              },
              {
                kind:
                  current.selectedOptionId &&
                  current.selectedOptionId !== input.optionId
                    ? "option_counterproposed"
                    : "option_approved",
                actorUserId: actorId,
                optionId: input.optionId,
              },
            ),
            current.revision,
          );
        })
        .immediate();
    if (
      !value.participants.every((id) => value.approvals[id] === input.optionId)
    )
      return await this.view(actorId, value);
    try {
      const available = await this.availability(value);
      const selected = value.options.find(
        (option) => option.id === input.optionId,
      )!;
      const confirmed = await this.db
        .transaction(async () => {
          const current = await this.writable(
            actorId,
            value.id,
            value.revision,
          );
          await this.validateCoverage(current, available.coverages);
          const constraints = await Promise.all(
            current.participants.map((id) => this.constraints(id, current.id)),
          );
          if (
            !available.coverages.every((coverage, index) =>
              this.permitted(coverage, selected, constraints[index]),
            )
          )
            throw new MeetingError("availability_changed");
          return await this.save(
            this.withActivity(
              {
                ...current,
                status: "confirmed",
                checkedAt: new Date().toISOString(),
                availabilitySource: available.source,
                error: null,
              },
              { kind: "confirmed", optionId: input.optionId },
            ),
            current.revision,
          );
        })
        .immediate();
      return await this.view(actorId, confirmed);
    } catch (error) {
      await this.recordFailure(actorId, value, error);
      throw error;
    }
  }
  async setLocation(
    actorId: string,
    raw: { meetingId: string; revision: number; location: string },
  ): Promise<MeetingView> {
    const input = meetingLocationSchema.parse(raw);
    const value = await this.db
      .transaction(async () => {
        const current = await this.read(actorId, input.meetingId);
        await this.current(current);
        if (current.location === input.location) return current;
        await this.writable(actorId, current.id, input.revision);
        if (current.modality === "online")
          throw new MeetingError("meeting_changed");
        return this.save(
          this.withActivity(
            {
              ...current,
              location: input.location,
              approvals: {},
              selectedOptionId: null,
            },
            { kind: "location_updated", actorUserId: actorId },
          ),
          current.revision,
        );
      })
      .immediate();
    return this.view(actorId, value);
  }
  async publish(
    actorId: string,
    raw: { meetingId: string; revision: number },
  ): Promise<MeetingView> {
    const input = meetingRevisionSchema.parse(raw);
    const leaseKey = `meeting-publish:${input.meetingId}`;
    const lease = await this.db.acquireLease(leaseKey, 90_000);
    if (!lease) throw new MeetingError("publishing");
    let publishing: MeetingRecord | null = null;
    try {
      const value = await this.read(actorId, input.meetingId);
      await this.current(value);
      if (
        value.status !== "confirmed" ||
        !value.participants.every(
          (id) => value.approvals[id] === value.selectedOptionId,
        )
      )
        throw new MeetingError("approval_required");
      if (value.calendarPublication?.status === "scheduled")
        return this.view(actorId, value);
      if (!value.calendarPublication && value.revision !== input.revision)
        throw new MeetingError("meeting_changed");
      const slot = value.options.find(
        (item) => item.id === value.selectedOptionId,
      );
      if (!slot) throw new MeetingError("invalid_option");
      const spec = {
        id: value.id,
        purpose: value.purpose,
        location: value.location,
        modality: value.modality ?? ("in_person" as const),
        participants: value.participants,
        names: value.names,
        slot,
      };
      const prepared = await prepareMeetingCalendar(
        this.store,
        actorId,
        spec,
        value.calendarPublication,
      );
      const reconciled = value.calendarPublication
        ? await inspectPublishedMeeting(this.store, actorId, spec, prepared)
        : null;
      if (reconciled) {
        const saved = await this.db
          .transaction(async () => {
            const latest = await this.read(actorId, value.id);
            return this.save(
              { ...latest, calendarPublication: reconciled },
              latest.revision,
            );
          })
          .immediate();
        return this.view(actorId, saved);
      }
      {
        const available = await this.availability(value);
        await this.validateCoverage(value, available.coverages);
        const constraints = await Promise.all(
          value.participants.map((id) => this.constraints(id, value.id)),
        );
        if (
          !available.coverages.every((coverage, index) =>
            this.permitted(coverage, slot, constraints[index]),
          )
        )
          throw new MeetingError("availability_changed");
      }
      publishing = await this.db
        .transaction(async () => {
          const latest = await this.read(actorId, value.id);
          if (latest.revision !== value.revision)
            throw new MeetingError("meeting_changed");
          await this.current(latest);
          return this.save(
            { ...latest, calendarPublication: prepared },
            latest.revision,
          );
        })
        .immediate();
      const result = await publishApprovedMeeting(
        this.store,
        actorId,
        spec,
        prepared,
      );
      const saved = await this.db
        .transaction(async () => {
          const latest = await this.read(actorId, value.id);
          return this.save(
            { ...latest, calendarPublication: result },
            latest.revision,
          );
        })
        .immediate();
      return this.view(actorId, saved);
    } catch (error) {
      if (publishing?.calendarPublication) {
        await this.db
          .transaction(async () => {
            const latest = await this.read(actorId, publishing!.id);
            if (latest.calendarPublication?.status !== "publishing") return;
            await this.save(
              {
                ...latest,
                calendarPublication: {
                  ...latest.calendarPublication,
                  status: "failed",
                  updatedAt: new Date().toISOString(),
                  error:
                    "The calendar result could not be verified. Retry to check the same invitation.",
                },
              },
              latest.revision,
            );
          })
          .immediate();
      }
      throw error;
    } finally {
      await this.db.releaseLease(leaseKey, lease);
    }
  }
  async withdraw(
    actorId: string,
    raw: { meetingId: string; revision: number },
  ): Promise<MeetingView> {
    const input = meetingRevisionSchema.parse(raw);
    const result = await this.db
      .transaction(async () => {
        const value = await this.read(actorId, input.meetingId);
        if (value.calendarPublication)
          throw new MeetingError("calendar_published");
        if (value.status === "withdrawn") return value;
        if (value.revision !== input.revision)
          throw new MeetingError("meeting_changed");
        return await this.save(
          this.withActivity(
            {
              ...value,
              status: "withdrawn",
              consents: {},
              approvals: {},
              options: [],
              selectedOptionId: null,
              error: null,
            },
            { kind: "withdrawn", actorUserId: actorId },
          ),
          value.revision,
        );
      })
      .immediate();
    return await this.view(actorId, result);
  }
  async exportICS(actorId: string, meetingId: string): Promise<string> {
    const value = await this.db
      .transaction(async () => {
        const current = await this.read(actorId, meetingId);
        await this.current(current);
        return current;
      })
      .immediate();
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
