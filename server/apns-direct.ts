import { createHash, createPrivateKey, sign } from "node:crypto";
import * as http2 from "node:http2";
import type { PushRelayActivityRequest, PushRelaySendRequest } from "../shared/phone-push.ts";
import type { ApnsEnvironment, ResolvedApnsConfig } from "./apns-config.ts";

export const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/** Apple requires provider tokens to be refreshed no more often than every 20 minutes and at least every 60 minutes. */
export const APNS_TOKEN_WINDOW_MS = 50 * 60 * 1_000;
export const APNS_ALERT_EXPIRATION_SECONDS = 24 * 60 * 60;
export const APNS_ACTIVITY_EXPIRATION_SECONDS = 15 * 60;
export const APNS_ACTIVITY_STALE_SECONDS = 15 * 60;
export const LIVE_ACTIVITY_NAME = "BotActivity";
export const LIVE_ACTIVITY_ATTRIBUTES = "LiveActivityAttributes";

const APNS_REQUEST_TIMEOUT_MS = 10_000;
const APNS_SESSION_IDLE_MS = 5 * 60 * 1_000;
const NEEDS_YOU = new Set(["approval", "question", "sign-in", "mention"]);
const CATEGORY: Record<string, string> = { approval: "OPENMAUS_APPROVAL", question: "OPENMAUS_QUESTION" };
const CATEGORY_UPDATE = "OPENMAUS_UPDATE";
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
const PROVIDER_TOKEN_REASONS = new Set(["ExpiredProviderToken", "InvalidProviderToken", "MissingProviderToken"]);
const CREDENTIAL_REASONS = new Set([
  ...PROVIDER_TOKEN_REASONS,
  "TopicDisallowed",
  "BadTopic",
  "BadCertificate",
  "BadCertificateEnvironment",
]);

export interface ApnsRawRequest {
  origin: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface ApnsRawResponse {
  status: number;
  apnsId?: string;
  retryAfterSeconds?: number;
  body: string;
}

export type ApnsTransport = (request: ApnsRawRequest) => Promise<ApnsRawResponse>;

export type ApnsDeliveryResult =
  | { kind: "sent"; status: number; apnsId?: string }
  | { kind: "dead"; status: number; reason: string; invalidSince?: number }
  | { kind: "throttled"; status: number; reason: string; retryAfterMs?: number }
  | { kind: "credentials"; status: number; reason: string }
  | { kind: "transient"; status: number; reason: string }
  | { kind: "failed"; status: number; reason: string };

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function pushCategory(kind: string): string {
  return CATEGORY[kind] ?? CATEGORY_UPDATE;
}

function ombPayload(request: PushRelaySendRequest) {
  const { notification } = request;
  return {
    v: 1,
    kind: notification.kind,
    botId: notification.botId,
    botName: notification.botName,
    threadId: notification.threadId,
    ...(notification.roomId && notification.roomName ? { roomId: notification.roomId, roomName: notification.roomName } : {}),
    ...(request.pairing ? { pairing: request.pairing } : {}),
  };
}

/** `body` repeats `omb` because expo-notifications (SDK 58) exposes only `body` as `notification.request.content.data`. */
export function buildApnsAlertPayload(request: PushRelaySendRequest) {
  const { notification } = request;
  const omb = ombPayload(request);
  return {
    aps: {
      alert: { title: notification.title },
      sound: "default",
      "thread-id": notification.threadId,
      category: pushCategory(notification.kind),
      "interruption-level": NEEDS_YOU.has(notification.kind) ? "time-sensitive" : "active",
    },
    omb,
    body: omb,
  };
}

export function buildActivityProps(activity: PushRelayActivityRequest["activity"]) {
  if (activity.version === 1) {
    return {
      version: 1,
      botId: activity.botId,
      name: activity.botName,
      color: activity.color,
      body: activity.body,
      mood: activity.kind,
      kind: activity.kind,
      ask: activity.ask,
      status: activity.status,
      waiting: activity.waiting,
      since: activity.since,
      link: activity.link,
      answers: [],
    };
  }
  return {
    botId: activity.botId,
    name: activity.botName,
    color: activity.color,
    gradient: activity.gradient,
    body: activity.body,
    mood: activity.kind,
    kind: activity.kind,
    headline: activity.headline,
    line: "",
    since: activity.since,
    link: activity.link,
    answers: [],
  };
}

export function buildApnsLiveActivityPayload(request: PushRelayActivityRequest, now: number) {
  const seconds = Math.floor(now / 1_000);
  const contentState = { name: LIVE_ACTIVITY_NAME, props: JSON.stringify(buildActivityProps(request.activity)) };
  return {
    aps: {
      timestamp: seconds,
      event: request.event,
      "content-state": contentState,
      ...(request.event === "end" ? { "dismissal-date": seconds } : { "stale-date": seconds + APNS_ACTIVITY_STALE_SECONDS }),
      ...(request.event === "start" ? { "attributes-type": LIVE_ACTIVITY_ATTRIBUTES, attributes: { url: request.activity.link } } : {}),
      ...(request.event === "start" ? { alert: { title: request.activity.headline, body: request.activity.botName, sound: "default" } } : {}),
    },
  };
}

export function createApnsProviderJwt(config: Pick<ResolvedApnsConfig, "teamId" | "keyId" | "privateKey">, issuedAtSeconds: number): string {
  const header = base64urlJson({ alg: "ES256", kid: config.keyId });
  const claims = base64urlJson({ iss: config.teamId, iat: issuedAtSeconds });
  const signingInput = `${header}.${claims}`;
  // JWS ES256 (RFC 7518 §3.4) requires raw 64-byte IEEE P1363 (r || s), not ASN.1 DER.
  const signature = sign("sha256", Buffer.from(signingInput, "utf8"), {
    key: createPrivateKey({ key: config.privateKey, format: "pem" }),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function loopbackApnsOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.OMB_APNS_LOOPBACK_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export class Http2SessionPool {
  private readonly sessions = new Map<string, { session: http2.ClientHttp2Session; idle: ReturnType<typeof setTimeout> }>();

  private touch(origin: string, session: http2.ClientHttp2Session): void {
    const current = this.sessions.get(origin);
    if (current) clearTimeout(current.idle);
    const idle = setTimeout(() => {
      this.sessions.delete(origin);
      session.close();
    }, APNS_SESSION_IDLE_MS);
    idle.unref();
    this.sessions.set(origin, { session, idle });
  }

  private acquire(origin: string): http2.ClientHttp2Session {
    const existing = this.sessions.get(origin);
    if (existing && !existing.session.closed && !existing.session.destroyed) {
      this.touch(origin, existing.session);
      return existing.session;
    }
    if (existing) {
      clearTimeout(existing.idle);
      this.sessions.delete(origin);
    }
    const session = http2.connect(origin);
    const drop = () => {
      const entry = this.sessions.get(origin);
      if (entry?.session === session) {
        clearTimeout(entry.idle);
        this.sessions.delete(origin);
      }
    };
    session.on("close", drop);
    session.on("goaway", drop);
    session.on("error", drop);
    session.on("frameError", drop);
    this.touch(origin, session);
    return session;
  }

  send(request: ApnsRawRequest): Promise<ApnsRawResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      let stream: http2.ClientHttp2Stream | null = null;
      let session: http2.ClientHttp2Session | null = null;
      const timer = setTimeout(() => {
        stream?.close(http2.constants.NGHTTP2_CANCEL);
        if (session) {
          const entry = this.sessions.get(request.origin);
          if (entry?.session === session) {
            clearTimeout(entry.idle);
            this.sessions.delete(request.origin);
          }
          if (!session.destroyed) session.destroy();
        }
        finish(() => reject(new Error("APNs request timed out")));
      }, request.timeoutMs);
      timer.unref();

      try {
        session = this.acquire(request.origin);
      } catch (error) {
        finish(() => reject(error));
        return;
      }

      try {
        stream = session.request({
          [http2.constants.HTTP2_HEADER_METHOD]: "POST",
          [http2.constants.HTTP2_HEADER_PATH]: request.path,
          "content-type": "application/json",
          ...request.headers,
        });
      } catch (error) {
        finish(() => reject(error));
        return;
      }

      let status = 0;
      let apnsId: string | undefined;
      let retryAfterSeconds: number | undefined;
      const chunks: Buffer[] = [];

      stream.on("response", (headers) => {
        status = Number(headers[http2.constants.HTTP2_HEADER_STATUS] ?? 0);
        const rawId = headers["apns-id"];
        if (typeof rawId === "string" && rawId) apnsId = rawId;
        const rawRetry = Number(headers["retry-after"]);
        if (Number.isFinite(rawRetry) && rawRetry > 0) retryAfterSeconds = rawRetry;
      });
      stream.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("end", () => {
        finish(() => resolve({
          status,
          ...(apnsId ? { apnsId } : {}),
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      stream.on("error", (error) => {
        finish(() => reject(error));
      });
      stream.end(request.body, "utf8");
    });
  }

  close(): void {
    for (const { session, idle } of this.sessions.values()) {
      clearTimeout(idle);
      session.destroy();
    }
    this.sessions.clear();
  }
}

export interface ApnsDirectClientOptions {
  transport?: ApnsTransport;
  hosts?: Partial<Record<ApnsEnvironment, string>>;
  now?: () => number;
}

export class ApnsDirectClient {
  private readonly pool = new Http2SessionPool();
  private readonly transport: ApnsTransport;
  private readonly hosts: Record<ApnsEnvironment, string>;
  private readonly now: () => number;
  private cachedToken: { fingerprint: string; window: number; jwt: string } | null = null;

  constructor(options: ApnsDirectClientOptions = {}) {
    this.transport = options.transport ?? ((req) => this.pool.send(req));
    const loopback = loopbackApnsOrigin();
    this.hosts = {
      production: options.hosts?.production ?? loopback ?? APNS_HOSTS.production,
      sandbox: options.hosts?.sandbox ?? loopback ?? APNS_HOSTS.sandbox,
    };
    this.now = options.now ?? Date.now;
  }

  close(): void {
    this.pool.close();
  }

  forgetToken(): void {
    this.cachedToken = null;
  }

  private providerToken(config: ResolvedApnsConfig, now: number, forceFresh = false): string {
    const window = Math.floor(now / APNS_TOKEN_WINDOW_MS);
    const fingerprint = `${config.teamId}:${config.keyId}:${sha256Hex(config.privateKey)}`;
    if (!forceFresh && this.cachedToken && this.cachedToken.fingerprint === fingerprint && this.cachedToken.window === window) {
      return this.cachedToken.jwt;
    }
    const issuedAt = forceFresh ? Math.floor(now / 1_000) : Math.floor((window * APNS_TOKEN_WINDOW_MS) / 1_000);
    const jwt = createApnsProviderJwt(config, issuedAt);
    this.cachedToken = { fingerprint, window, jwt };
    return jwt;
  }

  async sendAlert(
    config: ResolvedApnsConfig,
    environment: ApnsEnvironment,
    request: PushRelaySendRequest,
  ): Promise<ApnsDeliveryResult> {
    const now = this.now();
    const collapseId = request.collapseId ?? sha256Hex(`${request.notification.kind}:${request.notification.threadId}`).slice(0, 32);
    return this.deliver({
      config,
      environment,
      token: request.token,
      pushType: "alert",
      priority: 10,
      expiresInSeconds: APNS_ALERT_EXPIRATION_SECONDS,
      collapseId,
      payload: buildApnsAlertPayload(request),
      now,
    });
  }

  async sendActivity(
    config: ResolvedApnsConfig,
    environment: ApnsEnvironment,
    request: PushRelayActivityRequest,
  ): Promise<ApnsDeliveryResult> {
    const now = this.now();
    return this.deliver({
      config,
      environment,
      token: request.token,
      pushType: "liveactivity",
      priority: request.event === "start" ? 10 : 5,
      expiresInSeconds: APNS_ACTIVITY_EXPIRATION_SECONDS,
      payload: buildApnsLiveActivityPayload(request, now),
      now,
    });
  }

  private async deliver(input: {
    config: ResolvedApnsConfig;
    environment: ApnsEnvironment;
    token: string;
    pushType: "alert" | "liveactivity";
    priority: 5 | 10;
    expiresInSeconds: number;
    collapseId?: string;
    payload: unknown;
    now: number;
  }): Promise<ApnsDeliveryResult> {
    const body = JSON.stringify(input.payload);
    // Apple requires `<bundleId>.push-type.liveactivity` as the topic for ActivityKit remote pushes.
    const topic = input.pushType === "liveactivity" ? `${input.config.bundleId}.push-type.liveactivity` : input.config.bundleId;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let providerToken: string;
      try {
        providerToken = this.providerToken(input.config, input.now, attempt > 0);
      } catch {
        return { kind: "credentials", status: 0, reason: "InvalidSigningKey" };
      }
      let response: ApnsRawResponse;
      try {
        response = await this.transport({
          origin: this.hosts[input.environment],
          path: `/3/device/${input.token}`,
          headers: {
            authorization: `bearer ${providerToken}`,
            "apns-topic": topic,
            "apns-push-type": input.pushType,
            "apns-priority": String(input.priority),
            "apns-expiration": String(Math.floor(input.now / 1_000) + input.expiresInSeconds),
            ...(input.collapseId ? { "apns-collapse-id": input.collapseId } : {}),
          },
          body,
          timeoutMs: APNS_REQUEST_TIMEOUT_MS,
        });
      } catch (error) {
        return { kind: "transient", status: 0, reason: error instanceof Error ? error.message : "NetworkError" };
      }

      if (response.status >= 200 && response.status < 300) {
        return { kind: "sent", status: response.status, ...(response.apnsId ? { apnsId: response.apnsId } : {}) };
      }

      const parsed = (() => {
        try {
          return JSON.parse(response.body) as { reason?: unknown; timestamp?: unknown };
        } catch {
          return null;
        }
      })();
      const reason = typeof parsed?.reason === "string" && parsed.reason ? parsed.reason : `HTTP_${response.status}`;

      if (attempt === 0 && response.status === 403 && PROVIDER_TOKEN_REASONS.has(reason)) {
        this.forgetToken();
        continue;
      }
      if (response.status === 410 || DEAD_TOKEN_REASONS.has(reason)) {
        const invalidSince = typeof parsed?.timestamp === "number" && Number.isFinite(parsed.timestamp) ? parsed.timestamp : undefined;
        return { kind: "dead", status: response.status, reason, ...(invalidSince !== undefined ? { invalidSince } : {}) };
      }
      if (response.status === 429 || reason === "TooManyRequests") {
        return {
          kind: "throttled",
          status: response.status,
          reason,
          ...(response.retryAfterSeconds ? { retryAfterMs: response.retryAfterSeconds * 1_000 } : {}),
        };
      }
      if ((response.status === 403 || response.status === 400) && CREDENTIAL_REASONS.has(reason)) {
        return { kind: "credentials", status: response.status, reason };
      }
      if (response.status >= 500 || response.status === 0) {
        return { kind: "transient", status: response.status, reason };
      }
      return { kind: "failed", status: response.status, reason };
    }
    return { kind: "credentials", status: 403, reason: "ExpiredProviderToken" };
  }
}
