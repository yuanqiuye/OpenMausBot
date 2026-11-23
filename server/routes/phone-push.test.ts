import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { apnsSavePatch, resolveApnsConfig, type ApnsConfig } from "../apns-config.ts";
import { ApnsDirectClient } from "../apns-direct.ts";
import { json, readBody } from "../harness/http.ts";
import { apnsStatusFor, PhonePush } from "../phone-push.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createPhoneApnsRoutes, createPhonePushRoutes } from "./phone-push.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(dirs.splice(0).map(removeTempDir));
});

const APNS = "ab".repeat(32);
const session = (id: string, cookieOnly = false): RequestAuth => ({
  kind: "session", via: "bearer", scopes: ["client"],
  session: { id, cookieOnly } as unknown as Extract<RequestAuth, { kind: "session" }>["session"],
});
const companion = (device: string): RequestAuth => ({ kind: "loopback", scopes: ["admin", "client"], companionDevice: device });
const desktop: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

async function setup(options: { enabled?: boolean; live?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "phone-push-routes-"));
  dirs.push(dir);
  const push = new PhonePush({
    dataDir: dir,
    access: () => null,
    enabled: () => options.enabled ?? true,
    live: () => false,
    room: () => undefined,
    log: () => {},
  });
  let auth: RequestAuth = session("s1");
  const routes = [createPhonePushRoutes({ push, live: () => options.live ?? true })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "elsewhere" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, contentType = "application/json") => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": contentType },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { push, call, as: (next: RequestAuth) => { auth = next; } };
}

describe("/api/push/device", () => {
  it("registers, reads back and removes the calling phone's own registration, never echoing the token", async () => {
    const { call, push } = await setup();
    const put = await call("PUT", "/api/push/device", { platform: "apns", token: APNS, pairing: "pair-tag-0001" });
    expect(put).toEqual({ status: 200, body: { push: "no-account", relay: "off", device: expect.objectContaining({ platform: "apns", pairing: "pair-tag-0001" }) } });
    expect(JSON.stringify(put.body)).not.toContain(APNS);
    expect((await call("GET", "/api/push/device")).body).toMatchObject({ push: "no-account", device: { platform: "apns" } });
    expect(push.answer("session:s1").device).not.toBeNull();
    expect(await call("DELETE", "/api/push/device")).toEqual({ status: 200, body: { push: "no-account", device: null } });
  });

  it("keys a companion phone by the device the sidecar vouched for, and refuses anything that is not a phone", async () => {
    const { call, as, push } = await setup();
    as(companion("device-7"));
    expect((await call("PUT", "/api/push/device", { platform: "apns", token: APNS })).status).toBe(200);
    expect(push.answer("companion:device-7").device).not.toBeNull();
    for (const who of [desktop, session("browser", true)]) {
      as(who);
      expect(await call("PUT", "/api/push/device", { platform: "apns", token: APNS })).toEqual({ status: 403, body: { error: expect.stringContaining("Only a paired phone") } });
    }
  });

  it("answers off and keeps nothing while phone push is switched off", async () => {
    const { call, push } = await setup({ enabled: false });
    expect(await call("PUT", "/api/push/device", { platform: "apns", token: APNS })).toEqual({ status: 200, body: { push: "off", relay: "off", device: null } });
    expect(push.answer("session:s1").device).toBeNull();
  });

  it("refuses an expired session, a body that is not JSON or not a registration, and other methods", async () => {
    expect((await (await setup({ live: false })).call("GET", "/api/push/device")).status).toBe(401);
    const { call } = await setup();
    expect((await call("PUT", "/api/push/device", "token=abc", "text/plain")).status).toBe(415);
    expect((await call("PUT", "/api/push/device", { platform: "apns", token: "nope" })).status).toBe(400);
    expect((await call("POST", "/api/push/device", { platform: "apns", token: APNS })).status).toBe(405);
    expect((await call("GET", "/api/push/devices")).body).toEqual({ from: "elsewhere" });
  });
});

describe("/api/push/apns", () => {
  it("lets only the computer owner save APNs settings, redacts the .p8 key, and delivers test pushes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phone-apns-routes-"));
    dirs.push(dir);
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateKeyPem = String(privateKey.export({ type: "pkcs8", format: "pem" })).trim();
    let apnsCfg: ApnsConfig | undefined;
    const apnsClient = new ApnsDirectClient({
      transport: async () => ({ status: 200, apnsId: "test-apns-id", body: "" }),
    });
    const push = new PhonePush({
      dataDir: dir,
      access: () => null,
      apns: () => resolveApnsConfig(apnsCfg),
      apnsClient,
      enabled: () => true,
      live: () => false,
      room: () => undefined,
      log: () => {},
    });
    let auth: RequestAuth = desktop;
    const routes = [
      createPhonePushRoutes({ push, live: () => true }),
      createPhoneApnsRoutes({
        push,
        live: () => true,
        status: () => apnsStatusFor({ apns: apnsCfg }, push.counts()),
        save: async (patch) => {
          apnsCfg = { ...apnsCfg, ...apnsSavePatch(patch) };
          push.resetPause();
          return apnsStatusFor({ apns: apnsCfg }, push.counts());
        },
      }),
    ];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "elsewhere" });
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };

    for (const forbidden of [session("phone-1"), companion("device-9")]) {
      auth = forbidden;
      expect((await call("GET", "/api/push/apns")).status).toBe(403);
      expect((await call("PUT", "/api/push/apns", { teamId: "TEAM123456" })).status).toBe(403);
      expect((await call("POST", "/api/push/apns/test")).status).toBe(403);
    }

    auth = desktop;
    expect((await call("PUT", "/api/push/apns", { teamId: "bad" })).status).toBe(400);
    const saved = await call("PUT", "/api/push/apns", {
      enabled: true,
      teamId: "team123456",
      keyId: "key1234567",
      bundleId: "com.example.mausbot",
      privateKey: privateKeyPem,
      environment: "sandbox",
    });
    expect(saved).toEqual({
      status: 200,
      body: {
        apns: {
          enabled: true,
          includePreview: true,
          configured: true,
          teamId: "TEAM123456",
          keyId: "KEY1234567",
          bundleId: "com.example.mausbot",
          environment: "sandbox",
          hasPrivateKey: true,
          apnsDevices: 0,
          activityTokens: 0,
        },
      },
    });
    expect(JSON.stringify(saved.body)).not.toContain("BEGIN PRIVATE KEY");

    expect((await call("POST", "/api/push/apns/test")).status).toBe(409);
    auth = session("phone-1");
    await call("PUT", "/api/push/device", { platform: "apns", token: APNS, environment: "sandbox" });
    auth = desktop;
    expect(await call("POST", "/api/push/apns/test")).toEqual({ status: 200, body: { ok: true, sent: 1, total: 1 } });

    const cloudRoute = createPhoneApnsRoutes({
      selfHosted: false,
      push,
      live: () => true,
      status: () => apnsStatusFor({ apns: apnsCfg }, push.counts()),
      save: async () => apnsStatusFor({ apns: apnsCfg }, push.counts()),
    });
    const cloudServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await dispatchRoutes([cloudRoute], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: desktop, json, readBody });
      if (!handled) json(res, 404, { from: "elsewhere" });
    });
    servers.push(cloudServer);
    await new Promise<void>((ready) => cloudServer.listen(0, "127.0.0.1", ready));
    const cloudBase = `http://127.0.0.1:${(cloudServer.address() as AddressInfo).port}`;
    expect((await fetch(`${cloudBase}/api/push/apns`)).status).toBe(403);
    expect((await fetch(`${cloudBase}/api/push/apns/test`, { method: "POST" })).status).toBe(403);
  });
});
