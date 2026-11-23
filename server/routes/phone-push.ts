// /api/push/device: a paired phone registers, reads back or removes its own closed-app alert registration. The phone is
// known by what authenticated the request (a paired session, or the device the companion vouched for), never the body.
import { z } from "zod";
import { PHONE_ACTIVITY_ROUTE, PHONE_PUSH_ROUTE } from "../../shared/phone-push.ts";
import { validateApnsFields, type ApnsSaveInput } from "../apns-config.ts";
import { activityRegistrationSchema, type PhoneActivity } from "../phone-activity.ts";
import { registrationSchema, type ApnsStatus, type PhonePush } from "../phone-push.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { phoneKey } from "./phones.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const SELF_ONLY = "Only a paired phone can register for alerts, and only for itself.";
const OWNER_ONLY = "Only the owner of this computer can manage iOS push credentials.";
export const PHONE_APNS_ROUTE = "/api/push/apns";
export const PHONE_APNS_TEST_ROUTE = "/api/push/apns/test";

const apnsSettingsBody = z.object({
  enabled: z.boolean().optional(),
  includePreview: z.boolean().optional(),
  teamId: z.string().max(32).optional(),
  keyId: z.string().max(32).optional(),
  bundleId: z.string().max(155).optional(),
  privateKey: z.string().max(16_384).optional(),
  clearPrivateKey: z.boolean().optional(),
  environment: z.enum(["production", "sandbox"]).optional(),
}).strict();

export interface PhonePushRouteDeps {
  push: PhonePush;
  live: (auth: RequestAuth) => boolean;
}

export function createPhonePushRoutes(deps: PhonePushRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }: RouteContext): Promise<typeof PASS | void> => {
    if (path !== PHONE_PUSH_ROUTE) return PASS;
    res.setHeader("Cache-Control", "no-store");
    if (!deps.live(auth)) return json(res, 401, { error: "Session expired" });
    const key = phoneKey(auth);
    if (!key) return json(res, 403, { error: SELF_ONLY });
    if (method === "GET") return json(res, 200, deps.push.answer(key));
    if (method === "DELETE") {
      await deps.push.remove(key);
      return json(res, 200, deps.push.answer(key));
    }
    if (method !== "PUT") return json(res, 405, { error: "Method not allowed" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON required" });
    const parsed = registrationSchema.safeParse(await readBody(req, 16_384));
    if (!deps.live(auth)) return json(res, 401, { error: "Session expired" });
    if (!parsed.success) return json(res, 400, { error: "Invalid push registration" });
    try {
      return json(res, 200, await deps.push.register(key, parsed.data));
    } catch (error) {
      const status = (error as { status?: unknown }).status === 409 ? 409 : 500;
      return json(res, status, { error: error instanceof Error ? error.message : "Could not save the registration" });
    }
  };
}

export interface PhoneActivityRouteDeps {
  push: PhonePush;
  activity: PhoneActivity;
  live: (auth: RequestAuth) => boolean;
}

/** /api/push/activity: the calling phone's Live Activity tokens, its words and its Android ongoing switch. */
export function createPhoneActivityRoutes(deps: PhoneActivityRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }: RouteContext): Promise<typeof PASS | void> => {
    if (path !== PHONE_ACTIVITY_ROUTE) return PASS;
    res.setHeader("Cache-Control", "no-store");
    if (!deps.live(auth)) return json(res, 401, { error: "Session expired" });
    const key = phoneKey(auth);
    if (!key) return json(res, 403, { error: SELF_ONLY });
    const answer = () => ({ push: deps.push.status(), activity: deps.activity.registration(key) });
    if (method === "GET") return json(res, 200, answer());
    if (method === "DELETE") {
      await deps.activity.remove(key);
      return json(res, 200, answer());
    }
    if (method !== "PUT") return json(res, 405, { error: "Method not allowed" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON required" });
    const parsed = activityRegistrationSchema.safeParse(await readBody(req, 32_768));
    if (!deps.live(auth)) return json(res, 401, { error: "Session expired" });
    if (!parsed.success) return json(res, 400, { error: "Invalid activity registration" });
    try {
      await deps.activity.register(key, parsed.data);
      return json(res, 200, answer());
    } catch (error) {
      const status = (error as { status?: unknown }).status === 409 ? 409 : 500;
      return json(res, status, { error: error instanceof Error ? error.message : "Could not save the registration" });
    }
  };
}

export interface PhoneApnsRouteDeps {
  selfHosted?: boolean;
  push: PhonePush;
  live: (auth: RequestAuth) => boolean;
  status: () => ApnsStatus;
  save: (patch: ApnsSaveInput) => Promise<ApnsStatus>;
  sampleTarget?: () => { botId: string; botName: string; threadId: string } | undefined;
}

export function createPhoneApnsRoutes(deps: PhoneApnsRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }: RouteContext): Promise<typeof PASS | void> => {
    if (path !== PHONE_APNS_ROUTE && path !== PHONE_APNS_TEST_ROUTE) return PASS;
    res.setHeader("Cache-Control", "no-store");
    if (deps.selfHosted === false) return json(res, 403, { error: OWNER_ONLY });
    if (!deps.live(auth)) return json(res, 401, { error: "Session expired" });
    if (!ownerOrAdmin(auth) || (auth.kind === "loopback" && Boolean(auth.companionDevice))) {
      return json(res, 403, { error: OWNER_ONLY });
    }
    if (path === PHONE_APNS_TEST_ROUTE) {
      if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
      const result = await deps.push.sendTest(deps.sampleTarget?.());
      if (!result.ok) {
        return json(res, result.status, { ok: false, error: result.error, ...(result.reasons?.length ? { reasons: result.reasons } : {}) });
      }
      return json(res, 200, result);
    }
    if (method === "GET") return json(res, 200, { apns: deps.status() });
    if (method !== "PUT") return json(res, 405, { error: "Method not allowed" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON required" });
    const raw = await readBody(req, 32_768).catch(() => undefined);
    if (!deps.live(auth)) return json(res, 401, { error: "Session expired" });
    const parsed = apnsSettingsBody.safeParse(raw);
    if (!parsed.success) return json(res, 400, { error: "Invalid APNs settings." });
    const checked = validateApnsFields(parsed.data);
    if (!checked.ok) return json(res, 400, { error: checked.error });
    try {
      const apns = await deps.save({
        ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
        ...(parsed.data.includePreview !== undefined ? { includePreview: parsed.data.includePreview } : {}),
        ...(checked.normalized.teamId !== undefined ? { teamId: checked.normalized.teamId } : {}),
        ...(checked.normalized.keyId !== undefined ? { keyId: checked.normalized.keyId } : {}),
        ...(checked.normalized.bundleId !== undefined ? { bundleId: checked.normalized.bundleId } : {}),
        ...(checked.normalized.privateKey !== undefined ? { privateKey: checked.normalized.privateKey } : {}),
        ...(parsed.data.clearPrivateKey ? { clearPrivateKey: true } : {}),
        ...(parsed.data.environment !== undefined ? { environment: parsed.data.environment } : {}),
      });
      return json(res, 200, { apns });
    } catch (error) {
      const status = (error as { status?: unknown }).status === 409 ? 409 : 500;
      return json(res, status, { error: error instanceof Error ? error.message : "Could not save APNs settings." });
    }
  };
}
