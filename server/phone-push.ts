// Closed-app phone alerts. A paired phone registers its APNs or FCM device token here; when an approval, a question, a
// sign-in request or a finished reply would reach a phone that holds no live event stream, this asks the push relay in
// the hosted control plane to wake it, with the installation credential this server already has. The push is
// content-free: kind, a title from names alone, opaque ids. Off unless `features.phonePush` (or OMB_PHONE_PUSH=1).
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { COMPANION_INSTALLATION_CREDENTIAL_FIELD } from "../electron/companion-account-service.mjs";
import { normalizeControlPlaneURL } from "../electron/control-plane-client.mjs";
import {
  APNS_TOKEN,
  FCM_TOKEN,
  PAIRING_TAG,
  PHONE_ACTIVITY_RELAY_PATH,
  PHONE_PUSH_RELAY_PATHS,
  PHONE_PUSH_WIRE_VERSION,
  PUSH_ID,
  PUSH_KINDS,
  PUSH_NAME_MAX,
  PUSH_RELAY_ERRORS,
  PUSH_TITLE_MAX,
  isPushKind,
  phonePushCollapseId,
  validPushToken,
  type PhonePushAnswer,
  type PhonePushNotification,
  type PhonePushRegistration,
  type PhonePushState,
  type PublicPushDevice,
  type PushKind,
} from "../shared/phone-push.ts";
import { apnsConfigWithEnv, resolveApnsConfig, usableApnsPrivateKey, type ApnsConfig, type ApnsEnvironment, type ResolvedApnsConfig } from "./apns-config.ts";
import { resolveBotNotificationVisual, type BotNotificationVisual } from "../shared/bot-notification-visual.ts";
import { ApnsDirectClient, type DirectApnsActivityRequest } from "./apns-direct.ts";
import { writeFileAtomic } from "./atomic.ts";
import { redactSecretsInText } from "./redact.ts";
import { conversationLanguage, serverLine, type ServerLineKey } from "./server-lines.ts";

export const PHONE_PUSH_FILE = "push-devices.json";
export const PHONE_PUSH_ENV = "OMB_PHONE_PUSH";
/** A push-only installation credential, for a server that holds no other (a Cloud home). */
export const PHONE_PUSH_CREDENTIAL_ENV = "OMB_PUSH_CREDENTIAL";
export const PHONE_PUSH_DESKTOP_MESSAGE = "openmausbot:phone-push-access";

const INSTALLATION_CREDENTIAL = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
/** As routes/phones.ts `phoneKey` mints them. */
export const PUSH_DEVICE_KEY = /^(companion|session):[\w-]{1,128}$/;
export const MAX_PUSH_DEVICES = 50;

/** One push per phone, kind and conversation in this window; the newest waiting one replaces an older one. */
export const PUSH_COALESCE_MS = 10_000;
export const PUSH_DEVICE_WINDOW_MS = 10 * 60_000;
export const PUSH_DEVICE_WINDOW_MAX = 30;
/** A push still undelivered after this is dropped: the phone shows the news when it next connects. */
export const PUSH_MAX_AGE_MS = 10 * 60_000;
/** Waits before each retry of a push the relay could not take (network, 5xx). */
export const PUSH_RETRY_MS = [5_000, 30_000, 120_000] as const;
/** How long the relay is left alone after it said it cannot push at all (no keys, credential refused). */
export const RELAY_UNAVAILABLE_PAUSE_MS = 60 * 60_000;
const RELAY_TIMEOUT_MS = 10_000;

const TITLES: Record<PushKind, ServerLineKey> = {
  approval: "server.notify.approval",
  question: "server.notify.question",
  "sign-in": "server.notify.signInWebsite",
  done: "server.notify.done",
};

const DIRECT_TITLES: Record<string, ServerLineKey> = {
  ...TITLES,
  secret: "server.notify.approval",
  "turn-failed": "server.notify.turnFailed",
  "routine-failed": "server.notify.routineFailed",
  incident: "server.notify.incident",
  mention: "server.notify.mention",
  wait: "server.notify.wait",
};

const DIRECT_KIND_SWITCHES: Record<string, readonly PushKind[]> = {
  approval: ["approval"],
  question: ["question"],
  "sign-in": ["sign-in"],
  secret: ["sign-in", "approval"],
  done: ["done"],
  mention: ["done"],
  wait: ["done"],
  "turn-failed": ["done", "approval", "question", "sign-in"],
  "routine-failed": ["done", "approval", "question", "sign-in"],
  incident: ["done", "approval", "question", "sign-in"],
};

const PUSH_PREVIEW_MAX = 180;
const GENERIC_THREAD_TITLES = new Set(["shared chat", "new task", "new thread", "new chat"]);

/** On when switched on (`OMB_PHONE_PUSH=1|0` wins over `features.phonePush`), or when local direct APNs is configured. */
export function phonePushEnabled(
  cfg: { features?: { phonePush?: boolean }; apns?: ApnsConfig },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[PHONE_PUSH_ENV] === "1") return true;
  if (env[PHONE_PUSH_ENV] === "0") return false;
  if (cfg.features?.phonePush !== undefined) return cfg.features.phonePush === true;
  return resolveApnsConfig(apnsConfigWithEnv(cfg.apns, env)) !== null;
}

export interface ApnsStatus {
  enabled: boolean;
  includePreview: boolean;
  configured: boolean;
  teamId: string;
  keyId: string;
  bundleId: string;
  environment: ApnsEnvironment;
  hasPrivateKey: boolean;
  apnsDevices: number;
  activityTokens: number;
}

export function apnsStatusFor(
  cfg: { apns?: ApnsConfig },
  counts: { apnsDevices: number; activityTokens: number } = { apnsDevices: 0, activityTokens: 0 },
): ApnsStatus {
  const apns = cfg.apns;
  return {
    enabled: apns?.enabled !== false,
    includePreview: apns?.includePreview !== false,
    configured: resolveApnsConfig(apns) !== null,
    teamId: apns?.teamId?.trim().toUpperCase() ?? "",
    keyId: apns?.keyId?.trim().toUpperCase() ?? "",
    bundleId: apns?.bundleId?.trim() ?? "",
    environment: apns?.environment === "production" ? "production" : "sandbox",
    hasPrivateKey: Boolean(usableApnsPrivateKey(apns)),
    apnsDevices: counts.apnsDevices,
    activityTokens: counts.activityTokens,
  };
}

const kindsSchema = z.array(z.enum(PUSH_KINDS)).max(PUSH_KINDS.length);

export const registrationSchema = z.discriminatedUnion("platform", [
  z.object({ platform: z.literal("apns"), token: z.string().trim().toLowerCase().regex(APNS_TOKEN), environment: z.enum(["production", "sandbox"]).optional(), pairing: z.string().regex(PAIRING_TAG).optional(), kinds: kindsSchema.optional() }).strict(),
  z.object({ platform: z.literal("fcm"), token: z.string().trim().regex(FCM_TOKEN), environment: z.literal("production").optional(), pairing: z.string().regex(PAIRING_TAG).optional(), kinds: kindsSchema.optional() }).strict(),
]);

const storedDevice = z.object({
  key: z.string().regex(PUSH_DEVICE_KEY),
  platform: z.enum(["apns", "fcm"]),
  token: z.string(),
  environment: z.enum(["production", "sandbox"]),
  pairing: z.string().regex(PAIRING_TAG).optional(),
  kinds: kindsSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
}).refine((device) => validPushToken(device.platform, device.token));
const storedActivityToken = z.object({
  key: z.string().regex(PUSH_DEVICE_KEY).optional(),
  token: z.string().regex(APNS_TOKEN),
  purpose: z.enum(["activity", "activity-start"]),
  environment: z.enum(["production", "sandbox"]),
  updatedAt: z.number(),
});
const storedFile = z.object({
  version: z.literal(1),
  devices: z.array(storedDevice).max(MAX_PUSH_DEVICES),
  activityTokens: z.array(storedActivityToken).max(MAX_PUSH_DEVICES * 4).optional(),
});
type StoredDevice = z.infer<typeof storedDevice>;
type StoredActivityToken = z.infer<typeof storedActivityToken>;

export interface PhonePushAccess {
  controlPlane: string;
  credential: string;
}

export type PushOutcome = "sent" | "dropped" | "stale" | "live" | "gone" | "failed" | "retry" | "paused";

export interface PhonePushOptions {
  dataDir: string;
  access: () => PhonePushAccess | null;
  apns?: () => ResolvedApnsConfig | null;
  apnsClient?: ApnsDirectClient;
  enabled: () => boolean;
  /** Whether this phone holds a live event stream right now. */
  live: (key: string) => boolean;
  /** The room a notification came out of, for its name. */
  room: (notification: PushableNotification) => { id: string; name: string } | undefined;
  /** Optional conversation/task title for local direct APNs subtitles (never sent to the hosted relay). */
  threadTitle?: (threadId: string, botId: string) => string | undefined;
  /** Optional bot appearance lookup for local direct APNs Communication Notification icons (never sent to the hosted relay). */
  bot?: (botId: string) => { color?: unknown; mascotBody?: unknown; mascotFaceColor?: unknown } | null | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/** The fields a push reads from a `notify` frame's notification; `title`/`body` stay local to direct APNs. */
export interface PushableNotification {
  kind: string;
  botId: string;
  botName: string;
  threadId: string;
  groupId?: string;
  title?: string;
  body?: string;
}

interface Job {
  key: string;
  slot: string;
  push: PhonePushNotification;
  directTitle?: string;
  directSubtitle?: string;
  directBody?: string;
  botVisual?: BotNotificationVisual;
  collapseId?: string;
  queuedAt: number;
  notBefore: number;
  attempts: number;
}

export interface RelayAnswer {
  status: number;
  code?: string;
  retryAfterMs?: number;
}

function clip(value: string, max: number): string {
  const points = [...value.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim()];
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : points.join("");
}

function pushableOf(value: unknown): PushableNotification | null {
  if (!value || typeof value !== "object") return null;
  const { kind, botId, botName, threadId, groupId, title, body } = value as Record<string, unknown>;
  if (typeof kind !== "string" || typeof botId !== "string" || typeof botName !== "string" || typeof threadId !== "string") return null;
  return {
    kind,
    botId,
    botName,
    threadId,
    ...(typeof groupId === "string" ? { groupId } : {}),
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof body === "string" ? { body } : {}),
  };
}

function buildPushNotification(
  notification: PushableNotification,
  room: { id: string; name: string } | undefined,
  titleKey: ServerLineKey,
): PhonePushNotification | null {
  if (!PUSH_ID.test(notification.botId) || !PUSH_ID.test(notification.threadId)) return null;
  const botName = clip(notification.botName, PUSH_NAME_MAX) || "MausBot";
  const roomName = room && PUSH_ID.test(room.id) ? clip(room.name, PUSH_NAME_MAX) : "";
  const language = conversationLanguage(notification.threadId);
  const who = roomName ? serverLine(language, "server.notify.inRoom", { bot: botName, room: roomName }) : botName;
  return {
    kind: notification.kind,
    title: clip(serverLine(language, titleKey, { who }), PUSH_TITLE_MAX),
    botId: notification.botId,
    botName,
    threadId: notification.threadId,
    ...(room && roomName ? { roomId: room.id, roomName } : {}),
  };
}

function cleanSubtitle(raw: string | undefined, botName: string, roomName?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = clip(redactSecretsInText(raw), PUSH_NAME_MAX);
  if (!cleaned) return undefined;
  const lower = cleaned.toLowerCase();
  if (GENERIC_THREAD_TITLES.has(lower)) return undefined;
  if (cleaned === botName || (roomName && cleaned === roomName)) return undefined;
  return cleaned;
}

/** The push for one notification, or null when it is not a kind a closed app is woken for or an id is not one the
 * relay takes. Reads the kind, the ids and the names; the title is the server's own line for that kind, from names. */
export function phonePushNotification(notification: PushableNotification, room?: { id: string; name: string }): PhonePushNotification | null {
  if (!isPushKind(notification.kind)) return null;
  return buildPushNotification(notification, room, TITLES[notification.kind]);
}

export class PhonePush {
  private devices: StoredDevice[] = [];
  private activityTokens: StoredActivityToken[] = [];
  private readonly file: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly apnsClient: ApnsDirectClient;
  private readonly log: (line: string) => void;
  private readonly timers: NonNullable<PhonePushOptions["timers"]>;
  private readonly sent = new Map<string, number[]>();
  private readonly lastBySlot = new Map<string, number>();
  private readonly outbox = new Map<string, Job>();
  private pausedUntil = 0;
  private timer: unknown = null;
  private draining: Promise<void> | null = null;
  private readonly options: PhonePushOptions;

  constructor(options: PhonePushOptions) {
    this.options = options;
    this.file = join(options.dataDir, PHONE_PUSH_FILE);
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apnsClient = options.apnsClient ?? new ApnsDirectClient({ now: this.now });
    this.log = options.log ?? ((line) => console.log(line));
    this.timers = options.timers ?? {
      set: (run, ms) => setTimeout(run, ms).unref(),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    const parsed = storedFile.safeParse(raw);
    if (parsed.success) {
      this.devices = parsed.data.devices;
      this.activityTokens = parsed.data.activityTokens ?? [];
    } else this.log("[phone-push] the saved phone registrations could not be read; phones register again when they connect");
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const payload = {
      version: 1,
      devices: this.devices,
      ...(this.activityTokens.length ? { activityTokens: this.activityTokens } : {}),
    };
    writeFileAtomic(this.file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  }

  status(): PhonePushState {
    if (!this.options.enabled()) return "off";
    return this.options.apns?.() || this.options.access() ? "on" : "no-account";
  }

  counts(): { apnsDevices: number; activityTokens: number } {
    return {
      apnsDevices: this.devices.filter((device) => device.platform === "apns").length,
      activityTokens: this.activityTokens.length,
    };
  }

  resetPause(): void {
    this.pausedUntil = 0;
    this.apnsClient.forgetToken();
    this.schedule();
  }

  private publicDevice(key: string): PublicPushDevice | null {
    const device = this.devices.find((candidate) => candidate.key === key);
    if (!device) return null;
    return { platform: device.platform, environment: device.environment, ...(device.pairing ? { pairing: device.pairing } : {}), kinds: [...device.kinds], updatedAt: device.updatedAt };
  }

  /** The device token a phone registered, for the Live Activity and ongoing-notification pushes that share its relay. */
  deviceOf(key: string): { platform: "apns" | "fcm"; token: string; environment: "production" | "sandbox" } | undefined {
    const device = this.devices.find((candidate) => candidate.key === key);
    return device ? { platform: device.platform, token: device.token, environment: device.environment } : undefined;
  }

  defaultApnsEnvironment(): ApnsEnvironment {
    return this.options.apns?.()?.defaultEnvironment ?? "production";
  }

  hasDirectApns(): boolean {
    return Boolean(this.options.enabled() && this.options.apns?.());
  }

  includePreview(): boolean {
    const apns = this.options.apns?.();
    return Boolean(apns && apns.includePreview);
  }

  threadTitleOf(threadId: string, botId: string): string | undefined {
    return this.options.threadTitle?.(threadId, botId);
  }

  isLive(key: string): boolean {
    return this.options.live(key);
  }

  /** One relay or direct-APNs call, as this server's installation; null when unreachable or unconfigured. */
  async call(path: string, body: unknown, key?: string): Promise<RelayAnswer | null> {
    const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
    if (path === PHONE_PUSH_RELAY_PATHS.register && record?.platform === "apns" && typeof record.token === "string" && APNS_TOKEN.test(record.token)) {
      const purpose = record.purpose === "activity" || record.purpose === "activity-start" ? record.purpose : null;
      if (purpose) {
        const environment: ApnsEnvironment = record.environment === "sandbox"
          ? "sandbox"
          : record.environment === "production"
            ? "production"
            : this.defaultApnsEnvironment();
        this.activityTokens = [
          ...this.activityTokens.filter((entry) => entry.token !== record.token).slice(-(MAX_PUSH_DEVICES * 4 - 1)),
          { ...(key && PUSH_DEVICE_KEY.test(key) ? { key } : {}), token: record.token, purpose, environment, updatedAt: this.now() },
        ];
        this.persist();
      }
      if (this.options.apns?.()) return { status: 200 };
    }
    if (path === PHONE_PUSH_RELAY_PATHS.unregister && record?.platform === "apns" && typeof record.token === "string") {
      const before = this.activityTokens.length;
      this.activityTokens = this.activityTokens.filter((entry) => entry.token !== record.token);
      if (this.activityTokens.length !== before) this.persist();
      if (this.options.apns?.() && !this.options.access()) return { status: 204 };
    }
    if (path === PHONE_ACTIVITY_RELAY_PATH && record && typeof record.token === "string" && APNS_TOKEN.test(record.token)) {
      const apns = this.options.apns?.();
      if (apns) {
        const phoneEnv = key ? this.devices.find((device) => device.key === key && device.platform === "apns")?.environment : undefined;
        const known = phoneEnv
          ?? this.activityTokens.find((entry) => entry.token === record.token)?.environment
          ?? apns.defaultEnvironment;
        const outcome = await this.apnsClient.sendActivity(apns, known, body as DirectApnsActivityRequest);
        if (outcome.kind === "sent") return { status: 202 };
        if (outcome.kind === "dead") {
          this.activityTokens = this.activityTokens.filter((entry) => entry.token !== record.token);
          this.persist();
          return { status: 410, code: PUSH_RELAY_ERRORS.unregistered };
        }
        if (outcome.kind === "throttled") return { status: 429, ...(outcome.retryAfterMs ? { retryAfterMs: outcome.retryAfterMs } : {}) };
        if (outcome.kind === "credentials") return { status: 503, code: PUSH_RELAY_ERRORS.unavailable };
        if (outcome.kind === "transient") return null;
        return { status: outcome.status || 400, code: outcome.reason };
      }
    }
    return this.relay(path, body);
  }

  answer(key: string): PhonePushAnswer {
    return { push: this.status(), device: this.publicDevice(key) };
  }

  /** The phone behind `key` registers or updates its token. Switched off, nothing is kept. A token belongs to one app on
   * one phone, so the same token under another key (a phone that paired again) moves to this key. */
  async register(key: string, input: PhonePushRegistration): Promise<PhonePushAnswer & { relay: "registered" | "pending" | "off" }> {
    if (!PUSH_DEVICE_KEY.test(key)) throw new Error("not a phone");
    if (!this.options.enabled()) return { ...this.answer(key), relay: "off" };
    const now = this.now();
    const previous = this.devices.find((device) => device.key === key);
    const others = this.devices.filter((device) => device.key !== key && device.token !== input.token);
    if (!previous && others.length >= MAX_PUSH_DEVICES) {
      throw Object.assign(new Error(`At most ${MAX_PUSH_DEVICES} phones can get alerts from this computer.`), { status: 409 });
    }
    const next: StoredDevice = {
      key,
      platform: input.platform,
      token: input.token,
      environment: input.platform === "apns" ? input.environment ?? this.defaultApnsEnvironment() : "production",
      ...(input.pairing ? { pairing: input.pairing } : {}),
      kinds: [...new Set(input.kinds ?? PUSH_KINDS)],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.devices = [...others, next];
    if (next.platform === "apns") {
      this.activityTokens = this.activityTokens.map((entry) => entry.key === key ? { ...entry, environment: next.environment } : entry);
    }
    this.persist();
    if (previous && previous.token !== next.token) void this.dropFromRelay(previous);
    if (this.status() !== "on") return { ...this.answer(key), relay: "off" };
    if (next.platform === "apns" && this.options.apns?.()) return { ...this.answer(key), relay: "registered" };
    const answer = await this.relay(PHONE_PUSH_RELAY_PATHS.register, this.registerBody(next));
    return { ...this.answer(key), relay: answer && answer.status < 300 ? "registered" : "pending" };
  }

  /** The phone asked to stop, or was unpaired: drop it here and at the relay. */
  async remove(key: string): Promise<boolean> {
    const device = this.devices.find((candidate) => candidate.key === key);
    if (!device) return false;
    this.devices = this.devices.filter((candidate) => candidate.key !== key);
    this.persist();
    for (const [slot, job] of this.outbox) if (job.key === key) this.outbox.delete(slot);
    await this.dropFromRelay(device);
    return true;
  }

  /** A paired phone was revoked or its session expired. */
  forget(key: string): void {
    void this.remove(key).catch((error) => this.log(`[phone-push] could not forget a phone: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async dropFromRelay(device: StoredDevice): Promise<void> {
    if (this.devices.some((other) => other.token === device.token)) return;
    if (device.platform === "apns" && this.options.apns?.() && !this.options.access()) return;
    await this.relay(PHONE_PUSH_RELAY_PATHS.unregister, { v: PHONE_PUSH_WIRE_VERSION, platform: device.platform, token: device.token });
  }

  private registerBody(device: StoredDevice) {
    return device.platform === "apns"
      ? { v: PHONE_PUSH_WIRE_VERSION, platform: "apns", token: device.token, environment: device.environment }
      : { v: PHONE_PUSH_WIRE_VERSION, platform: "fcm", token: device.token };
  }

  /**
   * A `notify` frame left this server as frame `seq`. Each registered phone that holds no live stream, wants this kind
   * and would have been shown the frame (`reaches`, the event stream's own audience rule) gets a push queued. Never
   * throws, and does nothing at all while switched off.
   */
  offer(frame: { notification: unknown; seq: number }, reaches: (key: string) => boolean): void {
    try {
      if (!this.devices.length || !this.options.enabled()) return;
      const notification = pushableOf(frame.notification);
      if (!notification) return;
      const apns = this.options.apns?.() ?? null;
      const titleKey = apns ? DIRECT_TITLES[notification.kind] : (isPushKind(notification.kind) ? TITLES[notification.kind] : undefined);
      if (!titleKey) return;
      const room = this.options.room(notification);
      const push = buildPushNotification(notification, room, titleKey);
      if (!push) return;
      const directTitle = notification.title ? clip(redactSecretsInText(notification.title), PUSH_TITLE_MAX) : undefined;
      const directSubtitle = cleanSubtitle(this.options.threadTitle?.(notification.threadId, notification.botId), push.botName, push.roomName);
      const directBody = notification.body ? clip(redactSecretsInText(notification.body), PUSH_PREVIEW_MAX) : undefined;
      const botVisual = apns ? resolveBotNotificationVisual(this.options.bot?.(notification.botId), notification.kind) : undefined;
      const collapseId = phonePushCollapseId(push.threadId, frame.seq);
      const now = this.now();
      for (const device of this.devices) {
        const directDevice = Boolean(apns && device.platform === "apns");
        const wantsKind = directDevice
          ? (DIRECT_KIND_SWITCHES[notification.kind]?.some((allowed) => device.kinds.includes(allowed)) ?? false)
          : (isPushKind(notification.kind) && device.kinds.includes(notification.kind));
        if (!wantsKind || this.options.live(device.key) || !reaches(device.key)) continue;
        const slot = `${device.key}|${push.kind}|${push.threadId}`;
        const waiting = this.outbox.get(slot);
        if (!waiting && now - (this.lastBySlot.get(slot) ?? -Infinity) < PUSH_COALESCE_MS) continue;
        this.outbox.set(slot, {
          key: device.key,
          slot,
          push,
          ...(directTitle ? { directTitle } : {}),
          ...(directSubtitle ? { directSubtitle } : {}),
          ...(directBody ? { directBody } : {}),
          ...(botVisual ? { botVisual } : {}),
          ...(collapseId ? { collapseId } : {}),
          queuedAt: now,
          notBefore: waiting?.notBefore ?? now,
          attempts: waiting?.attempts ?? 0,
        });
      }
      this.kick();
    } catch (error) {
      this.log(`[phone-push] could not queue a push: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Resolves once every push that is due has been tried. */
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Pushes waiting for a retry or the relay's pause. */
  pending(): number {
    return this.outbox.size;
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    if (!this.outbox.size) return;
    const due = Math.max(this.pausedUntil, Math.min(...[...this.outbox.values()].map((job) => job.notBefore)));
    if (due <= this.now()) {
      this.kick();
      return;
    }
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.kick();
    }, Math.max(due - this.now(), 0));
  }

  private async drain(): Promise<void> {
    for (;;) {
      const now = this.now();
      if (now < this.pausedUntil) return;
      const job = [...this.outbox.values()].find((candidate) => candidate.notBefore <= now);
      if (!job) return;
      this.outbox.delete(job.slot);
      const outcome = await this.attempt(job, now).catch((error: unknown) => {
        this.log(`[phone-push] could not push: ${error instanceof Error ? error.message : String(error)}`);
        return "failed" as const;
      });
      if (outcome === "retry") {
        const wait = PUSH_RETRY_MS[job.attempts];
        if (wait !== undefined && !this.outbox.has(job.slot)) this.outbox.set(job.slot, { ...job, attempts: job.attempts + 1, notBefore: this.now() + wait });
      }
      if (outcome === "paused") this.outbox.clear();
    }
  }

  private async attempt(job: Job, now: number): Promise<PushOutcome> {
    const device = this.devices.find((candidate) => candidate.key === job.key);
    if (!device || !this.options.enabled()) return "gone";
    if (now - job.queuedAt > PUSH_MAX_AGE_MS) return "stale";
    // The phone connected while this waited: its stream delivers the frame itself.
    if (this.options.live(job.key)) return "live";
    const recent = (this.sent.get(job.key) ?? []).filter((at) => now - at < PUSH_DEVICE_WINDOW_MS);
    if (recent.length >= PUSH_DEVICE_WINDOW_MAX) return "dropped";
    const body = { v: PHONE_PUSH_WIRE_VERSION, token: device.token, ...(device.pairing ? { pairing: device.pairing } : {}), ...(job.collapseId ? { collapseId: job.collapseId } : {}), notification: job.push };
    const apns = device.platform === "apns" ? this.options.apns?.() : null;
    if (apns) {
      const rich = apns.includePreview;
      const botVisual = job.botVisual ?? resolveBotNotificationVisual(this.options.bot?.(job.push.botId), job.push.kind);
      const directBody = {
        ...body,
        notification: rich && job.directTitle ? { ...job.push, title: job.directTitle } : job.push,
        ...(rich && job.directSubtitle ? { alertSubtitle: job.directSubtitle } : {}),
        ...(rich && job.directBody ? { alertBody: job.directBody } : {}),
        botVisual,
      };
      const outcome = await this.apnsClient.sendAlert(apns, device.environment, directBody);
      if (outcome.kind === "sent") {
        this.sent.set(job.key, [...recent, now]);
        this.lastBySlot.set(job.slot, now);
        if (this.lastBySlot.size > 2_000) this.lastBySlot.clear();
        return "sent";
      }
      if (outcome.kind === "dead") {
        if (outcome.status === 410 || outcome.reason === "Unregistered") {
          this.devices = this.devices.filter((candidate) => candidate.token !== device.token);
          this.persist();
          return "gone";
        }
        this.log(`[phone-push] direct APNs rejected device token (${outcome.reason})`);
        return "failed";
      }
      if (outcome.kind === "credentials") {
        this.log(`[phone-push] direct APNs rejected signing credentials (${outcome.reason})`);
        return this.pause(5 * 60_000);
      }
      if (outcome.kind === "throttled") return this.pause(outcome.retryAfterMs ?? 60_000);
      if (outcome.kind === "transient") return "retry";
      return "failed";
    }
    let answer = await this.relay(PHONE_PUSH_RELAY_PATHS.send, body);
    if (answer?.status === 404 && answer.code === PUSH_RELAY_ERRORS.unknownDevice) {
      const registered = await this.relay(PHONE_PUSH_RELAY_PATHS.register, this.registerBody(device));
      if (registered && registered.status < 300) answer = await this.relay(PHONE_PUSH_RELAY_PATHS.send, body);
    }
    if (!answer) return "retry";
    if (answer.status < 300) {
      this.sent.set(job.key, [...recent, now]);
      this.lastBySlot.set(job.slot, now);
      if (this.lastBySlot.size > 2_000) this.lastBySlot.clear();
      return "sent";
    }
    if (answer.status === 410 || answer.code === PUSH_RELAY_ERRORS.unregistered) {
      this.devices = this.devices.filter((candidate) => candidate.token !== device.token);
      this.persist();
      return "gone";
    }
    if (answer.code === PUSH_RELAY_ERRORS.unavailable || answer.status === 401 || answer.status === 404) return this.pause(RELAY_UNAVAILABLE_PAUSE_MS);
    if (answer.status === 429) return this.pause(answer.retryAfterMs ?? 60_000);
    if (answer.status >= 500) return "retry";
    return "failed";
  }

  private pause(ms: number): PushOutcome {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + Math.min(Math.max(ms, 1_000), 6 * 60 * 60_000));
    return "paused";
  }

  async sendTest(target?: { botId: string; botName: string; threadId: string }): Promise<
    | { ok: true; sent: number; total: number; reasons?: string[] }
    | { ok: false; status: 409 | 502; error: string; reasons?: string[] }
  > {
    const apns = this.options.apns?.();
    if (!apns) {
      return { ok: false, status: 409, error: "Save your Team ID, Key ID, Bundle ID, and .p8 private key first." };
    }
    const devices = this.devices.filter((device) => device.platform === "apns");
    if (!devices.length) {
      return { ok: false, status: 409, error: "No paired iPhone has registered for notifications yet. Open MausBot on your paired iPhone once so it registers its device token." };
    }
    const sample = target ?? { botId: "mausbot", botName: "MausBot", threadId: "test_notification" };
    const botName = clip(sample.botName, PUSH_NAME_MAX) || "MausBot";
    const threadId = PUSH_ID.test(sample.threadId) ? sample.threadId : "test_notification";
    const language = conversationLanguage(threadId) ?? "en";
    const push: PhonePushNotification = {
      kind: "done",
      title: serverLine(language, "server.notify.done", { who: botName }),
      botId: PUSH_ID.test(sample.botId) ? sample.botId : "mausbot",
      botName,
      threadId,
    };
    const subtitle = apns.includePreview
      ? cleanSubtitle(this.options.threadTitle?.(threadId, push.botId), botName) ?? (language.startsWith("zh") ? "本機 APNs 直連測試" : "Direct APNs test")
      : undefined;
    const previewBody = apns.includePreview
      ? (language === "zh-tw"
        ? "推播內容預覽與動態島即時進度已成功啟用。"
        : language.startsWith("zh")
          ? "推送内容预览与灵动岛实时进度已成功启用。"
          : "Rich notification previews and Dynamic Island live updates are active.")
      : undefined;
    const botVisual = resolveBotNotificationVisual(this.options.bot?.(push.botId), push.kind);
    let sent = 0;
    const reasons: string[] = [];
    for (const device of devices) {
      const outcome = await this.apnsClient.sendAlert(apns, device.environment, {
        v: PHONE_PUSH_WIRE_VERSION,
        token: device.token,
        ...(device.pairing ? { pairing: device.pairing } : {}),
        notification: push,
        ...(subtitle ? { alertSubtitle: subtitle } : {}),
        ...(previewBody ? { alertBody: previewBody } : {}),
        botVisual,
      });
      if (outcome.kind === "sent") {
        sent += 1;
        continue;
      }
      if (outcome.kind === "dead" && (outcome.status === 410 || outcome.reason === "Unregistered")) {
        this.devices = this.devices.filter((candidate) => candidate.token !== device.token);
        this.persist();
      }
      reasons.push(outcome.reason);
    }
    if (sent > 0) return { ok: true, sent, total: devices.length, ...(reasons.length ? { reasons } : {}) };
    const first = reasons[0] ?? "UnknownError";
    const hint = first === "DeviceTokenNotForTopic"
      ? "Apple rejected the Bundle ID for this iPhone token (DeviceTokenNotForTopic). Check that Bundle ID matches the re-signed IPA."
      : first === "BadDeviceToken"
        ? "Apple rejected the device token (BadDeviceToken). Check whether the IPA was signed with a Sandbox (Development) or Production profile."
        : first === "InvalidProviderToken" || first === "ExpiredProviderToken"
          ? `Apple rejected the signing credentials (${first}). Check Team ID, Key ID, and the .p8 private key.`
          : `Apple APNs rejected the test push (${first}).`;
    return { ok: false, status: 502, error: hint, reasons };
  }

  /** One POST to the relay; null when it could not be reached. The credential travels only in the Authorization header,
   * to the control plane's own origin, and is never logged. */
  private async relay(path: string, body: unknown): Promise<RelayAnswer | null> {
    const access = this.options.access();
    if (!access) return null;
    try {
      const response = await this.fetchImpl(`${access.controlPlane}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${access.credential}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        status: response.status,
        ...(typeof payload?.error === "string" ? { code: payload.error } : {}),
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1_000 } : {}),
      };
    } catch (error) {
      this.log(`[phone-push] the relay could not be reached: ${error instanceof Error ? error.name : "error"}`);
      return null;
    }
  }
}

/** A validated access pair, or null. */
export function phonePushAccess(controlPlane: unknown, credential: unknown): PhonePushAccess | null {
  const origin = typeof controlPlane === "string" ? normalizeControlPlaneURL(controlPlane) : "";
  if (!origin || typeof credential !== "string" || !INSTALLATION_CREDENTIAL.test(credential)) return null;
  return { controlPlane: origin, credential };
}

/** Where this server's control-plane access comes from, first match wins: the desktop app's private message (its
 * credential lives in the OS store this process cannot read), OMB_PUSH_CREDENTIAL, a fleet's
 * OMB_INSTALLATION_CREDENTIAL, `openmausbot login`'s tunnel-account.json. OMB_CONTROL_PLANE_URL overrides the origin. */
export class PhonePushAccessSource {
  private desktop: PhonePushAccess | null | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly options: { tunnelFile: string; defaultControlPlane: string };

  constructor(options: { env?: NodeJS.ProcessEnv; tunnelFile: string; defaultControlPlane: string }) {
    this.env = options.env ?? process.env;
    this.options = options;
  }

  /** The desktop app's message: true when it was one. */
  receive(message: unknown): boolean {
    if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== PHONE_PUSH_DESKTOP_MESSAGE) return false;
    const access = (message as { access?: unknown }).access;
    this.desktop = access && typeof access === "object"
      ? phonePushAccess((access as { controlPlane?: unknown }).controlPlane, (access as { credential?: unknown }).credential)
      : null;
    return true;
  }

  private controlPlane(): string {
    if (Object.hasOwn(this.env, "OMB_CONTROL_PLANE_URL")) return normalizeControlPlaneURL(this.env.OMB_CONTROL_PLANE_URL ?? "");
    return this.options.defaultControlPlane;
  }

  current(): PhonePushAccess | null {
    if (this.desktop !== undefined) return this.desktop;
    const fromEnv = this.env[PHONE_PUSH_CREDENTIAL_ENV]?.trim() || this.env.OMB_INSTALLATION_CREDENTIAL?.trim();
    if (fromEnv) return phonePushAccess(this.controlPlane(), fromEnv);
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(this.options.tunnelFile, "utf8"));
    } catch {
      return null;
    }
    const credential = document && typeof document === "object" ? (document as Record<string, unknown>)[COMPANION_INSTALLATION_CREDENTIAL_FIELD] : undefined;
    return phonePushAccess(this.controlPlane(), credential);
  }
}
