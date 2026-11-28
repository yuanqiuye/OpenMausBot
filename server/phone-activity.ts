// A paired phone's Live Activities (iPhone) and ongoing "working" notification (Android) while its app is closed. The
// phone registers its activity tokens and its own words; when a bot it would see starts needing the person, starts or
// stops working, and the phone holds no live stream, this asks the push relay to start, update or end that bot's
// activity. Names, kind and the phone's headline only. It rides phone push's switch, store rules and relay access, and
// its per-phone hourly cap. Not on a Team Cloud: a bot's state there (busy, waiting on an ask) is everyone's, not one
// person's, so it would show one person another's private work.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  APNS_TOKEN,
  FCM_TOKEN,
  PHONE_ACTIVITY_RELAY_PATH,
  PHONE_PUSH_RELAY_PATHS,
  PHONE_PUSH_WIRE_VERSION,
  PUSH_ID,
  PUSH_NAME_MAX,
  PUSH_RELAY_ERRORS,
  type ActivityAsk,
  type ActivityEvent,
  type ActivityKind,
  type ActivityVisual,
  type PhoneActivityRegistration,
  type PushRelayActivityRequest,
} from "../shared/phone-push.ts";
import type { DirectApnsActivityRequest, DirectApnsActivityState } from "./apns-direct.ts";
import { writeFileAtomic } from "./atomic.ts";
import {
  buildNeedsYouAnswers,
  clipActivityStatus,
  detectPhoneLanguage,
  extractActivityStep,
  formatCompletionStatus,
  formatProgressStep,
  type ActivityStepInput,
} from "./phone-activity-copy.ts";
import { PUSH_DEVICE_KEY, type PhonePush } from "./phone-push.ts";

export const PHONE_ACTIVITY_FILE = "push-activity.json";
export const MAX_ACTIVITY_PHONES = 50;
export const MAX_ACTIVITIES = 10;
export const MAX_VISUALS = 60;
export const DEFAULT_WORKING_START_DELAY_MS = 1_500;
export const DEFAULT_ACTIVITY_PROGRESS_MS = 6_000;
export const DEFAULT_COMPLETION_LINGER_MS = 30_000;
const STARTING_DEDUP_MS = 30_000;
const PUSH_START_MATCH_WINDOW_MS = 10 * 60_000;
const HEADLINE_MAX = 120;
/** A notification kind that means a bot needs the person, as the ask the phone's content state names. */
const ASK_OF_KIND: ReadonlyMap<string, ActivityAsk> = new Map([
  ["approval", "approval"],
  ["question", "question"],
  ["sign-in", "signIn"],
  ["secret", "other"],
]);
const DONE_KINDS: ReadonlySet<string> = new Set([
  "done", "turn-failed", "routine-failed", "routine-deferred", "incident", "delegation-settled", "brief", "mention", "wait",
]);

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const visualSchema = z.object({ color: hex, gradient: z.array(hex).min(1).max(4), body: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) }).strict();
const headline = z.string().min(1).max(HEADLINE_MAX).refine((value) => value.includes("{name}") && !/[\p{Cc}\u2028\u2029]/u.test(value));

const status = z.string().min(1).max(80).refine((value) => value.trim() === value && !/[\p{Cc}\u2028\u2029]/u.test(value));

export const activityRegistrationSchema = z.object({
  scheme: z.enum(["openmausbot", "openmausbot-dev", "openmausbot-next"]),
  headlines: z.object({ needsYou: headline, working: headline }).strict(),
  startToken: z.string().trim().toLowerCase().regex(APNS_TOKEN).optional(),
  activities: z.array(z.object({ botId: z.string().regex(PUSH_ID), token: z.string().trim().toLowerCase().regex(APNS_TOKEN) }).strict()).max(MAX_ACTIVITIES).optional(),
  visuals: z.record(z.string().regex(PUSH_ID), visualSchema).refine((value) => Object.keys(value).length <= MAX_VISUALS).optional(),
  fallbackVisual: visualSchema.optional(),
  ongoing: z.boolean().optional(),
  kinds: z.array(z.enum(["needsYou", "working"])).max(2).optional(),
  statuses: z.object({
    working: status,
    needsYou: z.object({ approval: status, question: status, signIn: status, other: status }).strict(),
  }).strict().optional(),
}).strict();

export const activityTokenAttachSchema = z.object({
  token: z.string().trim().toLowerCase().regex(APNS_TOKEN),
  activityId: z.string().trim().min(1).max(128).optional(),
  botId: z.string().regex(PUSH_ID).optional(),
}).strict();

const storedSchema = z.object({ version: z.literal(1), phones: z.array(z.object({ key: z.string().regex(PUSH_DEVICE_KEY), registration: activityRegistrationSchema, updatedAt: z.number() })).max(MAX_ACTIVITY_PHONES) });
type Stored = z.infer<typeof storedSchema>["phones"][number];

/** The neutral look of a pushed activity for a bot the phone never drew. */
export const FALLBACK_VISUAL: ActivityVisual = { color: "#7C5CFF", gradient: ["#B9A9FF", "#7C5CFF", "#48369A"], body: "cursor" };

interface BotState {
  kind: ActivityKind;
  since: number;
  name: string;
  threadId: string;
}

export interface PhoneActivityOptions {
  dataDir: string;
  push: PhonePush;
  /** Whether a bot has an approval, question or sign-in card waiting on the person. */
  hasOpenAsk: (botId: string) => boolean;
  /** The bot as it is now: its name, whether any of its conversations is working, and which. */
  bot: (botId: string) => { name: string; busy: boolean; threadId: string } | undefined;
  /** The bot a conversation belongs to. */
  botOfThread: (threadId: string) => string | undefined;
  /** False where activities are not offered at all (a Team Cloud): nothing is kept and nothing is pushed. */
  available?: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
  /** Frames for one bot gather this long before its state is read again. */
  settleMs?: number;
  workingStartDelayMs?: number;
  progressIntervalMs?: number;
  lingerMs?: number;
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/** The runtime events that change whether a bot is working or waiting on the person. */
const STATE_EVENTS: ReadonlySet<string> = new Set(["turn.started", "turn.completed", "turn.retrying", "turn.wait_started", "turn.wait_ended", "request.opened", "request.resolved", "session.exited"]);
const PROGRESS_EVENTS: ReadonlySet<string> = new Set(["turn.progress", "item.started"]);

interface ScheduledTimer {
  due: number;
  handle: unknown;
  run: () => void;
}

interface DoneSummary {
  kind: string;
  text: string;
  threadId: string;
  at: number;
}

export type ActivityOutcome = { key: string; botId: string; event: ActivityEvent; via: "apns" | "fcm"; result: "sent" | "dropped" | "failed" };

function headlineFor(template: string, name: string): string {
  const filled = template.replace("{name}", name).replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim();
  const points = [...filled];
  return points.length > HEADLINE_MAX ? `${points.slice(0, HEADLINE_MAX - 1).join("")}…` : filled;
}

function clipName(name: string): string {
  const points = [...name.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim()];
  return (points.length > PUSH_NAME_MAX ? `${points.slice(0, PUSH_NAME_MAX - 1).join("")}…` : points.join("")) || "MausBot";
}

export class PhoneActivity {
  private phones: Stored[] = [];
  private readonly file: string;
  private readonly options: PhoneActivityOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** What each bot is doing now, from the frames that passed. */
  private readonly bots = new Map<string, BotState>();
  /** Each bot's last known name and conversation, for an end that comes after its state is gone. */
  private readonly seen = new Map<string, { name: string; threadId: string }>();
  /** What each phone was last sent per bot, so only a change goes out. */
  private readonly shown = new Map<string, Map<string, ActivityKind>>();
  /** The bots each phone has been told about since its app last connected; any other may still show what the app drew. */
  private readonly told = new Map<string, Set<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, unknown>();
  private readonly reach = new Map<string, (key: string) => boolean>();
  private readonly askThread = new Map<string, string>();
  private readonly askKind = new Map<string, ActivityAsk>();
  private readonly askSummary = new Map<string, string>();
  private readonly stepRaw = new Map<string, ActivityStepInput>();
  private readonly doneSummary = new Map<string, DoneSummary>();
  private readonly startingUntil = new Map<string, number>();
  private readonly pushedWorkingTurn = new Map<string, number>();
  private readonly pendingPushStarts = new Map<string, Array<{ botId: string; at: number }>>();
  private readonly serverAttachedActivities = new Map<string, { botId: string; token: string; at: number }>();
  private readonly lastProgressAt = new Map<string, number>();
  private readonly lastStatusSent = new Map<string, string>();
  private readonly workingStartTimers = new Map<string, ScheduledTimer>();
  private readonly progressTimers = new Map<string, ScheduledTimer>();
  private readonly lingerTimers = new Map<string, ScheduledTimer>();
  private readonly timers: NonNullable<PhoneActivityOptions["timers"]>;

  constructor(options: PhoneActivityOptions) {
    this.options = options;
    this.file = join(options.dataDir, PHONE_ACTIVITY_FILE);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.log(line));
    this.timers = options.timers ?? {
      set: (run: () => void, ms: number) => setTimeout(run, ms).unref(),
      clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    const parsed = storedSchema.safeParse(raw);
    if (parsed.success) this.phones = parsed.data.phones;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ version: 1, phones: this.phones }, null, 2)}\n`, { mode: 0o600 });
  }

  /** A registration as the phone may read it back: never a token. */
  registration(key: string): { scheme: string; headlines: Record<ActivityKind, string>; ongoing: boolean; kinds: ActivityKind[]; activities: string[]; canStart: boolean } | null {
    const found = this.phones.find((phone) => phone.key === key)?.registration;
    if (!found) return null;
    return {
      scheme: found.scheme,
      headlines: found.headlines,
      ongoing: found.ongoing === true,
      kinds: found.kinds ?? ["needsYou", "working"],
      activities: (found.activities ?? []).map(({ botId }) => botId),
      canStart: Boolean(found.startToken),
    };
  }

  /** Replaces this phone's registration. Switched off, nothing is kept. Tokens it no longer lists are unregistered. */
  async register(key: string, input: z.infer<typeof activityRegistrationSchema>): Promise<"off" | "saved"> {
    if (!PUSH_DEVICE_KEY.test(key)) throw new Error("not a phone");
    if (this.options.push.status() === "off" || this.options.available?.() === false) return "off";
    const now = this.now();
    const previous = this.phones.find((phone) => phone.key === key);
    const others = this.phones.filter((phone) => phone.key !== key);
    if (!previous && others.length >= MAX_ACTIVITY_PHONES) throw Object.assign(new Error("Too many phones"), { status: 409 });

    const explicitActivities = [...(input.activities ?? [])];
    const explicitBotIds = new Set(explicitActivities.map(({ botId }) => botId));
    const prefix = `${key}|`;
    for (const [slotKey, attached] of Array.from(this.serverAttachedActivities.entries())) {
      if (!slotKey.startsWith(prefix)) continue;
      if (explicitBotIds.has(attached.botId) || this.options.push.isLive(key)) {
        this.serverAttachedActivities.delete(slotKey);
        continue;
      }
      const keepActive = this.bots.has(attached.botId)
        || this.lingerTimers.has(slotKey)
        || (this.doneSummary.get(attached.botId)?.at ?? 0) > now - 60_000;
      if (keepActive && explicitActivities.length < MAX_ACTIVITIES) {
        explicitActivities.push({ botId: attached.botId, token: attached.token });
      } else {
        this.serverAttachedActivities.delete(slotKey);
      }
    }
    const effectiveInput: z.infer<typeof activityRegistrationSchema> = explicitActivities.length
      ? { ...input, activities: explicitActivities }
      : input;

    this.phones = [...others, { key, registration: effectiveInput, updatedAt: now }];
    this.persist();
    const environment = this.options.push.deviceOf(key)?.environment ?? this.options.push.defaultApnsEnvironment();
    const tokens = (registration: PhoneActivityRegistration | undefined) => new Map<string, "activity" | "activity-start">([
      ...(registration?.startToken ? [[registration.startToken, "activity-start"] as const] : []),
      ...(registration?.activities ?? []).map(({ token }) => [token, "activity"] as const),
    ]);
    const before = tokens(previous?.registration);
    const after = tokens(effectiveInput);
    for (const token of before.keys()) {
      if (!after.has(token)) void this.options.push.call(PHONE_PUSH_RELAY_PATHS.unregister, { v: PHONE_PUSH_WIRE_VERSION, platform: "apns", token }, key);
    }
    if (this.options.push.status() === "on") {
      for (const [token, purpose] of after) {
        if (!before.has(token)) await this.options.push.call(PHONE_PUSH_RELAY_PATHS.register, { v: PHONE_PUSH_WIRE_VERSION, platform: "apns", purpose, token, environment }, key);
      }
    }
    // The phone said which activities it holds: anything it no longer lists is not on screen.
    const listed = new Set((effectiveInput.activities ?? []).map(({ botId }) => botId));
    const shown = this.shown.get(key);
    if (shown) for (const botId of shown.keys()) if (!listed.has(botId) && !effectiveInput.ongoing) shown.delete(botId);

    if (this.hasDirectApns() && !this.options.push.isLive(key)) {
      const prevTokens = new Map((previous?.registration.activities ?? []).map(({ botId, token }) => [botId, token]));
      const storedPhone = this.phones.find((candidate) => candidate.key === key);
      if (storedPhone) {
        for (const { botId, token } of effectiveInput.activities ?? []) {
          const slotKey = `${key}|${botId}`;
          const wasStarting = (this.startingUntil.get(slotKey) ?? 0) > this.now();
          this.startingUntil.delete(slotKey);
          this.clearSlotTimer(this.workingStartTimers, slotKey);
          if (prevTokens.get(botId) === token) continue;
          const reaches = this.reach.get(botId);
          if (reaches && !reaches(key)) continue;
          const current = this.bots.get(botId);
          const wanted = current && (effectiveInput.kinds ?? ["needsYou", "working"]).includes(current.kind) ? current.kind : undefined;
          if (wanted) {
            const nextShown = this.shown.get(key) ?? new Map<string, ActivityKind>();
            this.shown.set(key, nextShown);
            nextShown.set(botId, wanted);
            this.enqueue(storedPhone, botId, wanted, wanted);
          } else if (wasStarting || (this.doneSummary.get(botId)?.at ?? 0) > this.now() - 60_000) {
            this.enqueueCompletion(storedPhone, botId);
          }
        }
      }
    }
    return "saved";
  }

  /** Attaches an APNs per-activity token minted on iOS after a push-to-start wake without overwriting other activities. */
  async attachPushStartedToken(
    key: string,
    input: z.infer<typeof activityTokenAttachSchema>,
  ): Promise<"off" | "unregistered" | "ignored" | "attached"> {
    if (!PUSH_DEVICE_KEY.test(key)) throw new Error("not a phone");
    if (this.options.push.status() === "off") return "off";
    const phone = this.phones.find((candidate) => candidate.key === key);
    if (!phone) return "unregistered";
    const now = this.now();
    const existingActivities = phone.registration.activities ?? [];
    const existingBotIds = new Set(existingActivities.map((entry) => entry.botId));

    let targetBotId = input.botId;
    const pendingQueue = (this.pendingPushStarts.get(key) ?? []).filter((item) => now - item.at < PUSH_START_MATCH_WINDOW_MS);
    if (!targetBotId) {
      const exactIdx = pendingQueue.findIndex((item) => !existingBotIds.has(item.botId));
      const pickedIdx = exactIdx >= 0 ? exactIdx : (pendingQueue.length ? 0 : -1);
      if (pickedIdx >= 0) {
        targetBotId = pendingQueue[pickedIdx]!.botId;
        pendingQueue.splice(pickedIdx, 1);
      }
    } else {
      const idx = pendingQueue.findIndex((item) => item.botId === targetBotId);
      if (idx >= 0) pendingQueue.splice(idx, 1);
    }
    if (pendingQueue.length) this.pendingPushStarts.set(key, pendingQueue);
    else this.pendingPushStarts.delete(key);

    if (!targetBotId) {
      for (const candidateBotId of this.bots.keys()) {
        if (existingBotIds.has(candidateBotId)) continue;
        const reaches = this.reach.get(candidateBotId);
        if (!reaches || reaches(key)) {
          targetBotId = candidateBotId;
          break;
        }
      }
    }
    if (!targetBotId) {
      for (const [candidateBotId, summary] of this.doneSummary.entries()) {
        if (now - summary.at > 60_000 || existingBotIds.has(candidateBotId)) continue;
        const reaches = this.reach.get(candidateBotId);
        if (!reaches || reaches(key)) {
          targetBotId = candidateBotId;
          break;
        }
      }
    }
    if (!targetBotId) return "ignored";

    const slotKey = `${key}|${targetBotId}`;
    const prevToken = existingActivities.find((entry) => entry.botId === targetBotId)?.token;
    this.serverAttachedActivities.set(slotKey, { botId: targetBotId, token: input.token, at: now });
    this.startingUntil.delete(slotKey);
    this.clearSlotTimer(this.workingStartTimers, slotKey);

    if (prevToken !== input.token) {
      const filtered = existingActivities.filter((entry) => entry.botId !== targetBotId && entry.token !== input.token);
      const nextActivities = [...filtered, { botId: targetBotId, token: input.token }].slice(-MAX_ACTIVITIES);
      phone.registration = { ...phone.registration, activities: nextActivities };
      phone.updatedAt = now;
      this.persist();
      if (prevToken) {
        void this.options.push.call(PHONE_PUSH_RELAY_PATHS.unregister, { v: PHONE_PUSH_WIRE_VERSION, platform: "apns", token: prevToken }, key);
      }
      const environment = this.options.push.deviceOf(key)?.environment ?? this.options.push.defaultApnsEnvironment();
      await this.options.push.call(
        PHONE_PUSH_RELAY_PATHS.register,
        { v: PHONE_PUSH_WIRE_VERSION, platform: "apns", purpose: "activity", token: input.token, environment },
        key,
      );
    }

    if (this.hasDirectApns() && !this.options.push.isLive(key)) {
      const reaches = this.reach.get(targetBotId);
      if (!reaches || reaches(key)) {
        const current = this.bots.get(targetBotId);
        const wanted = current && (phone.registration.kinds ?? ["needsYou", "working"]).includes(current.kind) ? current.kind : undefined;
        if (wanted) {
          const nextShown = this.shown.get(key) ?? new Map<string, ActivityKind>();
          this.shown.set(key, nextShown);
          nextShown.set(targetBotId, wanted);
          this.enqueue(phone, targetBotId, wanted, wanted);
        } else {
          this.enqueueCompletion(phone, targetBotId);
        }
      }
    }
    return "attached";
  }

  async remove(key: string): Promise<void> {
    const previous = this.phones.find((phone) => phone.key === key);
    if (!previous) return;
    this.phones = this.phones.filter((phone) => phone.key !== key);
    this.shown.delete(key);
    this.pendingPushStarts.delete(key);
    const prefix = `${key}|`;
    for (const slotKey of this.pushedWorkingTurn.keys()) {
      if (slotKey.startsWith(prefix)) this.pushedWorkingTurn.delete(slotKey);
    }
    for (const slotKey of this.serverAttachedActivities.keys()) {
      if (slotKey.startsWith(prefix)) this.serverAttachedActivities.delete(slotKey);
    }
    this.clearKeyTimers(key);
    this.persist();
    const tokens = [previous.registration.startToken, ...(previous.registration.activities ?? []).map(({ token }) => token)].filter((token): token is string => Boolean(token));
    await Promise.all(tokens.map((token) => this.options.push.call(PHONE_PUSH_RELAY_PATHS.unregister, { v: PHONE_PUSH_WIRE_VERSION, platform: "apns", token })));
  }

  forget(key: string): void {
    void this.remove(key).catch((error) => this.log(`[phone-activity] could not forget a phone: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Resolves once every change offered so far has been sent (or given up). */
  async flush(): Promise<void> {
    await this.queue;
  }

  /**
   * A `bot`, `notify` or `runtime` frame left the server. After its bot's frames settle, what the bot is doing is read
   * again and, for each registered phone with no live stream that would have seen the frame, the change is pushed.
   * Never throws, and does nothing while phone push is off.
   */
  offer(payload: Record<string, unknown>, reaches: (key: string) => boolean): void {
    try {
      if (!this.phones.length || this.options.push.status() !== "on" || this.options.available?.() === false) return;
      const botId = this.botOf(payload);
      if (!botId) return;
      this.reach.set(botId, reaches);
      if (this.pending.has(botId)) return;
      this.pending.set(botId, this.timers.set(() => {
        this.pending.delete(botId);
        this.settle(botId);
      }, this.options.settleMs ?? 250));
    } catch (error) {
      this.log(`[phone-activity] could not queue: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private hasDirectApns(): boolean {
    return this.options.push.hasDirectApns?.() === true;
  }

  private includePreview(): boolean {
    return this.hasDirectApns() && this.options.push.includePreview?.() === true;
  }

  private setSlotTimer(map: Map<string, ScheduledTimer>, slotKey: string, delayMs: number, run: () => void): void {
    this.clearSlotTimer(map, slotKey);
    const due = this.now() + Math.max(delayMs, 0);
    const handle = this.timers.set(() => {
      map.delete(slotKey);
      run();
    }, Math.max(delayMs, 0));
    map.set(slotKey, { due, handle, run });
  }

  private clearSlotTimer(map: Map<string, ScheduledTimer>, slotKey: string): void {
    const existing = map.get(slotKey);
    if (!existing) return;
    this.timers.clear(existing.handle);
    map.delete(slotKey);
  }

  private clearKeyTimers(key: string): void {
    const prefix = `${key}|`;
    for (const map of [this.workingStartTimers, this.progressTimers, this.lingerTimers]) {
      for (const slotKey of map.keys()) {
        if (slotKey.startsWith(prefix)) this.clearSlotTimer(map, slotKey);
      }
    }
    for (const slotKey of this.startingUntil.keys()) {
      if (slotKey.startsWith(prefix)) this.startingUntil.delete(slotKey);
    }
    for (const slotKey of this.lastProgressAt.keys()) {
      if (slotKey.startsWith(prefix)) this.lastProgressAt.delete(slotKey);
    }
    for (const slotKey of this.lastStatusSent.keys()) {
      if (slotKey.startsWith(prefix)) this.lastStatusSent.delete(slotKey);
    }
  }

  /** The bot a frame is about, noting the conversation an ask came from; null for a frame that changes no activity. */
  private botOf(payload: Record<string, unknown>): string | null {
    if (payload.kind === "notify") {
      const notification = payload.notification as Record<string, unknown> | undefined;
      const botId = notification?.botId, threadId = notification?.threadId, kind = notification?.kind;
      if (typeof botId !== "string" || typeof kind !== "string" || !PUSH_ID.test(botId)) return null;
      const ask = ASK_OF_KIND.get(kind);
      if (ask) {
        if (typeof threadId === "string") this.askThread.set(botId, threadId);
        this.askKind.set(botId, ask);
        const rawBody = typeof notification?.body === "string" ? notification.body : "";
        const cleaned = clipActivityStatus(rawBody, 56);
        if (cleaned) this.askSummary.set(botId, cleaned);
        return botId;
      }
      if (this.hasDirectApns() && DONE_KINDS.has(kind)) {
        const rawBody = typeof notification?.body === "string" ? notification.body : "";
        this.doneSummary.set(botId, {
          kind,
          text: clipActivityStatus(rawBody, 56),
          threadId: typeof threadId === "string" ? threadId : (this.seen.get(botId)?.threadId ?? botId),
          at: this.now(),
        });
        return botId;
      }
      return null;
    }
    if (payload.kind === "bot") {
      const botId = (payload.bot as Record<string, unknown> | undefined)?.id;
      return typeof botId === "string" && PUSH_ID.test(botId) ? botId : null;
    }
    if (payload.kind === "runtime") {
      const event = payload.event as Record<string, unknown> | undefined;
      if (typeof event?.type !== "string" || typeof event.threadId !== "string") return null;
      const isState = STATE_EVENTS.has(event.type);
      const isProgress = this.includePreview() && PROGRESS_EVENTS.has(event.type);
      if (!isState && !isProgress) return null;
      const botId = this.options.botOfThread(event.threadId);
      if (!botId || !PUSH_ID.test(botId)) return null;
      if (event.type === "turn.started") {
        this.stepRaw.delete(botId);
        this.doneSummary.delete(botId);
      } else if (event.type === "turn.retrying") {
        this.stepRaw.set(botId, { activity: "retrying" });
      } else if (event.type === "turn.wait_started") {
        this.stepRaw.set(botId, { activity: "waiting" });
      } else if (event.type === "turn.wait_ended") {
        if (this.stepRaw.get(botId)?.activity === "waiting") this.stepRaw.delete(botId);
      } else if (event.type === "request.opened") {
        if (typeof event.summary === "string" && !this.askSummary.has(botId)) {
          const cleaned = clipActivityStatus(event.summary, 56);
          if (cleaned) this.askSummary.set(botId, cleaned);
        }
        if (typeof event.requestKind === "string" && !this.askKind.has(botId)) {
          const mapped: ActivityAsk = event.requestKind === "approval"
            ? "approval"
            : event.requestKind === "user_input"
              ? "question"
              : event.requestKind === "auth"
                ? "signIn"
                : "other";
          this.askKind.set(botId, mapped);
        }
      } else if (isProgress) {
        const extracted = extractActivityStep(event);
        if (!extracted) return null;
        const prev = this.stepRaw.get(botId);
        if (prev && prev.activity === extracted.activity && prev.target === extracted.target && prev.file === extracted.file && prev.tool === extracted.tool) {
          return null;
        }
        this.stepRaw.set(botId, extracted);
      }
      return botId;
    }
    return null;
  }

  /** Reads what the bot is doing now and pushes each phone the change, if any. */
  private settle(botId: string): void {
    try {
      if (this.options.push.status() !== "on") return;
      const now = this.now();
      const bot = this.options.bot(botId);
      const previous = this.bots.get(botId);
      const kind: ActivityKind | undefined = !bot ? undefined : this.options.hasOpenAsk(botId) ? "needsYou" : bot.busy ? "working" : undefined;
      if (bot) this.remember(botId, bot.name, kind === "needsYou" ? this.askThread.get(botId) ?? bot.threadId : bot.threadId);
      if (kind && bot) this.bots.set(botId, { kind, since: previous?.kind === kind ? previous.since : now, name: bot.name, threadId: this.seen.get(botId)?.threadId ?? bot.threadId });
      else this.bots.delete(botId);
      if (kind !== "needsYou") {
        this.askThread.delete(botId);
        this.askKind.delete(botId);
        this.askSummary.delete(botId);
      }
      if (!kind) this.stepRaw.delete(botId);
      const directApns = this.hasDirectApns();
      const reaches = this.reach.get(botId) ?? (() => false);
      for (const phone of this.phones) {
        const slotKey = `${phone.key}|${botId}`;
        if (this.options.push.isLive(phone.key)) {
          // Its app draws its own activities while connected; after, the server starts from nothing.
          this.shown.delete(phone.key);
          this.told.delete(phone.key);
          this.clearKeyTimers(phone.key);
          continue;
        }
        if (!reaches(phone.key)) continue;
        const shown = this.shown.get(phone.key) ?? new Map<string, ActivityKind>();
        this.shown.set(phone.key, shown);
        const told = this.told.get(phone.key) ?? new Set<string>();
        this.told.set(phone.key, told);
        const firstNews = !told.has(botId);
        told.add(botId);
        const wanted = kind && (phone.registration.kinds ?? ["needsYou", "working"]).includes(kind) ? kind : undefined;
        const was = shown.get(botId);
        const running = phone.registration.activities?.find((entry) => entry.botId === botId);

        if (wanted) {
          this.clearSlotTimer(this.lingerTimers, slotKey);
          if (wanted === "needsYou") this.pushedWorkingTurn.delete(slotKey);
        } else {
          this.pushedWorkingTurn.delete(slotKey);
          this.clearSlotTimer(this.workingStartTimers, slotKey);
          this.clearSlotTimer(this.progressTimers, slotKey);
        }

        if (wanted === "working" && !was && directApns && !running && phone.registration.startToken && !phone.registration.ongoing) {
          const currentSince = this.bots.get(botId)?.since;
          if (currentSince !== undefined && this.pushedWorkingTurn.get(slotKey) === currentSince) {
            continue;
          }
          if (!this.workingStartTimers.has(slotKey) && now >= (this.startingUntil.get(slotKey) ?? 0)) {
            const delay = this.options.workingStartDelayMs ?? DEFAULT_WORKING_START_DELAY_MS;
            this.setSlotTimer(this.workingStartTimers, slotKey, delay, () => this.fireWorkingStart(phone.key, botId));
          }
          continue;
        }

        if (wanted === "needsYou") {
          this.clearSlotTimer(this.workingStartTimers, slotKey);
          this.clearSlotTimer(this.progressTimers, slotKey);
        }

        if (wanted === was) {
          if (wanted === "working" && directApns && running && this.includePreview()) {
            this.maybePushProgress(phone, botId, now);
            continue;
          }
          // The app may have drawn this bot before it went quiet: end what it left, once.
          const drawn = phone.registration.ongoing === true || Boolean(running);
          if (firstNews && !wanted && drawn) this.enqueue(phone, botId, undefined, "working", true);
          continue;
        }
        if (wanted) shown.set(botId, wanted);
        else shown.delete(botId);
        this.enqueue(phone, botId, wanted, was);
      }
    } catch (error) {
      this.log(`[phone-activity] could not push: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private fireWorkingStart(key: string, botId: string): void {
    const phone = this.phones.find((candidate) => candidate.key === key);
    const state = this.bots.get(botId);
    if (!phone || !state || state.kind !== "working" || this.options.push.status() !== "on" || this.options.push.isLive(key)) return;
    const reaches = this.reach.get(botId);
    if (reaches && !reaches(key)) return;
    if (!(phone.registration.kinds ?? ["needsYou", "working"]).includes("working")) return;
    const running = phone.registration.activities?.find((entry) => entry.botId === botId);
    const slotKey = `${key}|${botId}`;
    const now = this.now();
    if (!running && !phone.registration.startToken) return;
    if (!running && this.pushedWorkingTurn.get(slotKey) === state.since) return;
    if (!running && now < (this.startingUntil.get(slotKey) ?? 0)) return;
    const shown = this.shown.get(key) ?? new Map<string, ActivityKind>();
    this.shown.set(key, shown);
    shown.set(botId, "working");
    this.enqueue(phone, botId, "working", undefined);
  }

  private maybePushProgress(phone: Stored, botId: string, now: number): void {
    const state = this.bots.get(botId);
    if (!state || state.kind !== "working") return;
    const slotKey = `${phone.key}|${botId}`;
    const nextActivity = this.activityBody(phone, botId, "working", state, botId);
    const desired = nextActivity.status ?? nextActivity.headline;
    if (!desired || desired === this.lastStatusSent.get(slotKey)) return;
    const interval = this.options.progressIntervalMs ?? DEFAULT_ACTIVITY_PROGRESS_MS;
    const lastAt = this.lastProgressAt.get(slotKey) ?? 0;
    const elapsed = now - lastAt;
    if (elapsed >= interval) {
      this.clearSlotTimer(this.progressTimers, slotKey);
      this.enqueue(phone, botId, "working", "working");
      return;
    }
    if (!this.progressTimers.has(slotKey)) {
      this.setSlotTimer(this.progressTimers, slotKey, interval - elapsed, () => {
        const freshPhone = this.phones.find((candidate) => candidate.key === phone.key);
        const freshState = this.bots.get(botId);
        if (!freshPhone || !freshState || freshState.kind !== "working" || this.options.push.isLive(phone.key)) return;
        if (!freshPhone.registration.activities?.some((entry) => entry.botId === botId)) return;
        this.enqueue(freshPhone, botId, "working", "working");
      });
    }
  }

  /** Runs every settle and due timer that is waiting now, then waits for the sends. */
  async flushNow(): Promise<void> {
    for (;;) {
      let progressed = false;
      for (const [botId, handle] of Array.from(this.pending.entries())) {
        this.timers.clear(handle);
        this.pending.delete(botId);
        this.settle(botId);
        progressed = true;
      }
      const now = this.now();
      for (const map of [this.workingStartTimers, this.progressTimers, this.lingerTimers]) {
        for (const [slotKey, entry] of Array.from(map.entries())) {
          if (entry.due <= now) {
            this.timers.clear(entry.handle);
            map.delete(slotKey);
            entry.run();
            progressed = true;
          }
        }
      }
      await this.queue;
      if (!progressed) break;
    }
  }

  private remember(botId: string, name: string, threadId: string): void {
    this.seen.delete(botId);
    this.seen.set(botId, { name, threadId });
    for (const oldest of this.seen.keys()) {
      if (this.seen.size <= 500) break;
      this.seen.delete(oldest);
    }
  }

  private enqueue(phone: Stored, botId: string, wanted: ActivityKind | undefined, was: ActivityKind | undefined, forceImmediateEnd = false): void {
    const state = this.bots.get(botId);
    this.queue = this.queue.then(() => this.send(phone, botId, wanted, was, state, forceImmediateEnd)).catch((error: unknown) => {
      this.log(`[phone-activity] could not push: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private enqueueCompletion(phone: Stored, botId: string): void {
    this.queue = this.queue.then(() => this.sendCompletionLinger(phone, botId)).catch((error: unknown) => {
      this.log(`[phone-activity] could not push completion: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private activityBody(phone: Stored, botId: string, kind: ActivityKind, state: BotState | undefined, fallbackName: string): DirectApnsActivityState {
    const registration = phone.registration;
    const visual = registration.visuals?.[botId] ?? registration.fallbackVisual ?? FALLBACK_VISUAL;
    const known = state ?? this.seen.get(botId);
    const name = clipName(known?.name ?? fallbackName);
    const threadId = known?.threadId ?? botId;
    const statuses = registration.statuses;
    const ask: ActivityAsk = kind === "needsYou" ? this.askKind.get(botId) ?? "other" : "other";
    const directApns = this.hasDirectApns();
    const preview = this.includePreview();
    const language = directApns ? detectPhoneLanguage(registration, threadId) : "en";

    let statusText = statuses ? (kind === "working" ? statuses.working : statuses.needsYou[ask]) : undefined;
    let lineText: string | undefined;
    if (preview) {
      if (kind === "working") {
        const rawStep = this.stepRaw.get(botId);
        const taskTitle = clipActivityStatus(this.options.push.threadTitleOf?.(threadId, botId) ?? "", 44);
        const richStep = rawStep ? formatProgressStep(language, rawStep) : "";
        if (richStep) {
          statusText = statuses ? richStep : undefined;
          lineText = richStep;
        } else if (taskTitle && taskTitle.toLowerCase() !== "new thread" && taskTitle.toLowerCase() !== "new task" && taskTitle !== name) {
          const base = statuses?.working ?? "";
          statusText = statuses ? clipActivityStatus(base ? `${base} · ${taskTitle}` : taskTitle) : undefined;
          lineText = taskTitle;
        }
      } else if (kind === "needsYou") {
        const detail = this.askSummary.get(botId);
        if (detail) {
          const base = statuses?.needsYou[ask] ?? "";
          statusText = statuses ? clipActivityStatus(base ? `${base} · ${detail}` : detail) : undefined;
          lineText = detail;
        }
      }
    }

    const answers = directApns && statuses && kind === "needsYou"
      ? buildNeedsYouAnswers(language, registration.scheme, threadId, ask)
      : undefined;

    return {
      botId,
      botName: name,
      kind,
      headline: headlineFor(registration.headlines[kind], name),
      since: state?.since ?? this.now(),
      link: `${registration.scheme}://chat/${encodeURIComponent(threadId)}`,
      ...visual,
      ...(lineText && !statuses ? { line: lineText } : {}),
      ...(answers ? { answers } : {}),
      // Content state version 1 only for a phone that registered its words for it.
      ...(statuses ? {
        version: 1 as const,
        ask,
        status: statusText ?? (kind === "working" ? statuses.working : statuses.needsYou[ask]),
        waiting: [...this.bots.values()].filter((bot) => bot.kind === "needsYou").length,
      } : {}),
    };
  }

  private completionActivityBody(phone: Stored, botId: string): DirectApnsActivityState {
    const registration = phone.registration;
    const visual = registration.visuals?.[botId] ?? registration.fallbackVisual ?? FALLBACK_VISUAL;
    const done = this.doneSummary.get(botId);
    const known = this.seen.get(botId);
    const name = clipName(known?.name ?? botId);
    const threadId = done?.threadId ?? known?.threadId ?? botId;
    const language = detectPhoneLanguage(registration, threadId);
    const { headline, status } = formatCompletionStatus(language, name, done, this.includePreview());
    const statuses = registration.statuses;
    return {
      botId,
      botName: name,
      kind: "idle",
      headline,
      since: this.now(),
      link: `${registration.scheme}://chat/${encodeURIComponent(threadId)}`,
      ...visual,
      ...(!statuses ? { line: status } : {}),
      ...(statuses ? {
        version: 1 as const,
        ask: "other" as const,
        status,
        waiting: [...this.bots.values()].filter((bot) => bot.kind === "needsYou").length,
      } : {}),
    };
  }

  private async sendCompletionLinger(phone: Stored, botId: string): Promise<ActivityOutcome[]> {
    const outcomes: ActivityOutcome[] = [];
    const currentPhone = this.phones.find((candidate) => candidate.key === phone.key) ?? phone;
    const running = currentPhone.registration.activities?.find((entry) => entry.botId === botId);
    if (!running) return outcomes;
    const slotKey = `${currentPhone.key}|${botId}`;
    const envLinger = process.env.OMB_PHONE_ACTIVITY_LINGER_MS !== undefined
      ? Number(process.env.OMB_PHONE_ACTIVITY_LINGER_MS)
      : NaN;
    const lingerMs = this.options.lingerMs ?? (Number.isFinite(envLinger) && envLinger >= 0 ? envLinger : DEFAULT_COMPLETION_LINGER_MS);
    const activity = this.completionActivityBody(currentPhone, botId);
    this.lastStatusSent.delete(slotKey);
    this.lastProgressAt.delete(slotKey);
    const updateOutcome = await this.post(currentPhone.key, botId, {
      v: PHONE_PUSH_WIRE_VERSION,
      token: running.token,
      event: "update",
      staleSeconds: Math.max(Math.ceil(lingerMs / 1_000) + 15, 30),
      activity,
    }, "apns");
    outcomes.push(updateOutcome);
    if (updateOutcome.result === "dropped") return outcomes;
    this.setSlotTimer(this.lingerTimers, slotKey, lingerMs, () => {
      if (this.bots.has(botId) || this.options.push.isLive(currentPhone.key)) return;
      const latestPhone = this.phones.find((candidate) => candidate.key === currentPhone.key);
      const latestRunning = latestPhone?.registration.activities?.find((entry) => entry.botId === botId);
      if (!latestPhone || !latestRunning) return;
      const endActivity = this.completionActivityBody(latestPhone, botId);
      this.queue = this.queue.then(async () => {
        await this.post(latestPhone.key, botId, {
          v: PHONE_PUSH_WIRE_VERSION,
          token: latestRunning.token,
          event: "end",
          dismissalSeconds: Math.floor(this.now() / 1_000),
          activity: endActivity,
        }, "apns");
        this.dropActivity(latestPhone.key, botId);
      }).catch((error: unknown) => {
        this.log(`[phone-activity] could not end lingered activity: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    return outcomes;
  }

  private async send(
    phone: Stored,
    botId: string,
    wanted: ActivityKind | undefined,
    was: ActivityKind | undefined,
    state: BotState | undefined,
    forceImmediateEnd = false,
  ): Promise<ActivityOutcome[]> {
    const outcomes: ActivityOutcome[] = [];
    const currentPhone = this.phones.find((candidate) => candidate.key === phone.key) ?? phone;
    const registration = currentPhone.registration;
    const kind = wanted ?? was;
    if (!kind) return outcomes;
    const slotKey = `${currentPhone.key}|${botId}`;
    const directApns = this.hasDirectApns();
    const activity = this.activityBody(currentPhone, botId, kind, state, botId);
    const newlyNeedsYou = wanted === "needsYou" && was !== "needsYou";
    const newlyWorking = directApns && wanted === "working" && !was;
    const event: ActivityEvent = wanted ? "update" : "end";

    const running = registration.activities?.find((entry) => entry.botId === botId);
    if (running) {
      if (!wanted && directApns && !forceImmediateEnd) {
        outcomes.push(...await this.sendCompletionLinger(currentPhone, botId));
      } else {
        const sent = await this.post(currentPhone.key, botId, { v: PHONE_PUSH_WIRE_VERSION, token: running.token, event, activity }, "apns");
        outcomes.push(sent);
        if (wanted === "working" && sent.result === "sent") {
          this.lastProgressAt.set(slotKey, this.now());
          this.lastStatusSent.set(slotKey, activity.status ?? activity.headline);
        }
        if (event === "end") {
          this.lastProgressAt.delete(slotKey);
          this.lastStatusSent.delete(slotKey);
          this.dropActivity(currentPhone.key, botId);
        }
      }
    } else if ((newlyNeedsYou || newlyWorking) && registration.startToken) {
      const now = this.now();
      const alreadyPushedTurn = newlyWorking && state !== undefined && this.pushedWorkingTurn.get(slotKey) === state.since;
      if (!alreadyPushedTurn && (!directApns || now >= (this.startingUntil.get(slotKey) ?? 0))) {
        if (directApns) this.startingUntil.set(slotKey, now + STARTING_DEDUP_MS);
        const startReq: DirectApnsActivityRequest = {
          v: PHONE_PUSH_WIRE_VERSION,
          token: registration.startToken,
          event: "start",
          alert: true,
          ...(newlyWorking ? { silentStartAlert: true } : {}),
          activity,
        };
        const sent = await this.post(currentPhone.key, botId, startReq, "apns");
        outcomes.push(sent);
        if (sent.result === "sent") {
          if (newlyWorking && state !== undefined) this.pushedWorkingTurn.set(slotKey, state.since);
          if (directApns) {
            const pendingQueue = (this.pendingPushStarts.get(currentPhone.key) ?? [])
              .filter((item) => now - item.at < PUSH_START_MATCH_WINDOW_MS && item.botId !== botId);
            pendingQueue.push({ botId, at: now });
            this.pendingPushStarts.set(currentPhone.key, pendingQueue);
          }
          this.lastProgressAt.set(slotKey, now);
          this.lastStatusSent.set(slotKey, activity.status ?? activity.headline);
        } else {
          this.startingUntil.delete(slotKey);
        }
      }
    }

    const device = this.options.push.deviceOf(currentPhone.key);
    if (registration.ongoing && device?.platform === "fcm" && FCM_TOKEN.test(device.token)) {
      const relaySafeActivity: PushRelayActivityRequest["activity"] = {
        botId: activity.botId,
        botName: activity.botName,
        kind,
        headline: activity.headline,
        since: activity.since,
        link: activity.link,
        color: activity.color,
        gradient: activity.gradient,
        body: activity.body,
        ...(activity.version === 1 ? { version: 1, ask: activity.ask, status: activity.status, waiting: activity.waiting } : {}),
      };
      outcomes.push(await this.post(currentPhone.key, botId, { v: PHONE_PUSH_WIRE_VERSION, token: device.token, event, activity: relaySafeActivity }, "fcm"));
    }
    return outcomes;
  }

  private async post(key: string, botId: string, body: DirectApnsActivityRequest | PushRelayActivityRequest, via: "apns" | "fcm"): Promise<ActivityOutcome> {
    const answer = await this.options.push.call(PHONE_ACTIVITY_RELAY_PATH, body, key);
    const base = { key, botId, event: body.event, via } as const;
    if (answer && answer.status < 300) return { ...base, result: "sent" };
    if (answer && (answer.status === 410 || answer.code === PUSH_RELAY_ERRORS.unregistered || answer.code === PUSH_RELAY_ERRORS.unknownDevice)) {
      if (via === "apns") {
        if (body.event === "start") this.dropStartToken(key);
        else this.dropActivity(key, botId);
      }
      return { ...base, result: "dropped" };
    }
    return { ...base, result: "failed" };
  }

  private dropActivity(key: string, botId: string): void {
    this.serverAttachedActivities.delete(`${key}|${botId}`);
    const phone = this.phones.find((candidate) => candidate.key === key);
    const activities = phone?.registration.activities;
    if (!phone || !activities?.some((entry) => entry.botId === botId)) return;
    const removed = activities.filter((entry) => entry.botId === botId);
    phone.registration = { ...phone.registration, activities: activities.filter((entry) => entry.botId !== botId) };
    this.persist();
    for (const { token } of removed) void this.options.push.call(PHONE_PUSH_RELAY_PATHS.unregister, { v: PHONE_PUSH_WIRE_VERSION, platform: "apns", token });
  }

  private dropStartToken(key: string): void {
    const phone = this.phones.find((candidate) => candidate.key === key);
    if (!phone?.registration.startToken) return;
    const { startToken: _dropped, ...rest } = phone.registration;
    phone.registration = rest;
    this.persist();
  }
}
