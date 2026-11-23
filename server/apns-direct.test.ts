import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { resolveApnsConfig, validateApnsPrivateKey } from "./apns-config.ts";
import {
  APNS_TOKEN_WINDOW_MS,
  ApnsDirectClient,
  buildApnsAlertPayload,
  buildApnsLiveActivityPayload,
  createApnsProviderJwt,
  Http2SessionPool,
  type ApnsRawRequest,
} from "./apns-direct.ts";

function makeTestP8KeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKeyPem: String(privateKey.export({ type: "pkcs8", format: "pem" })).trim(),
    publicKeyPem: String(publicKey.export({ type: "spki", format: "pem" })).trim(),
  };
}

describe("apns-config and ApnsDirectClient", () => {
  const servers: http2.Http2Server[] = [];
  afterEach(async () => {
    while (servers.length) {
      const server = servers.pop()!;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("validates PKCS#8 P-256 keys and mints RFC 7518 ES256 provider JWTs", () => {
    const { privateKeyPem, publicKeyPem } = makeTestP8KeyPair();
    const checked = validateApnsPrivateKey(privateKeyPem.replace(/\n/g, "\\n"));
    expect(checked.ok).toBe(true);

    const resolved = resolveApnsConfig({
      teamId: "ab12cd34ef",
      keyId: "9988776655",
      bundleId: "com.example.mausbot",
      privateKey: privateKeyPem,
      environment: "sandbox",
    });
    expect(resolved).not.toBeNull();

    const jwt = createApnsProviderJwt(resolved!, 1_700_000_000);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    const sig = Buffer.from(parts[2]!, "base64url");
    expect(header).toEqual({ alg: "ES256", kid: "9988776655" });
    expect(claims).toEqual({ iss: "AB12CD34EF", iat: 1_700_000_000 });
    expect(sig.byteLength).toBe(64);
    expect(verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), {
      key: createPublicKey(publicKeyPem),
      dsaEncoding: "ieee-p1363",
    }, sig)).toBe(true);
  });

  it("reuses cached provider token within 50m window and refreshes on ExpiredProviderToken", async () => {
    const { privateKeyPem } = makeTestP8KeyPair();
    const config = resolveApnsConfig({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      bundleId: "com.example.mausbot",
      privateKey: privateKeyPem,
    })!;
    let clock = 1_700_000_123_000;
    const seenAuth: string[] = [];
    let failFirst = true;
    const client = new ApnsDirectClient({
      now: () => clock,
      transport: async (req: ApnsRawRequest) => {
        seenAuth.push(req.headers.authorization!);
        if (failFirst) {
          failFirst = false;
          return { status: 403, body: JSON.stringify({ reason: "ExpiredProviderToken" }) };
        }
        return { status: 200, apnsId: "apns-ok-1", body: "" };
      },
    });

    const first = await client.sendAlert(config, "sandbox", {
      v: 1,
      token: "a".repeat(64),
      pairing: "pair_12345678",
      notification: { kind: "approval", title: "Scout needs approval", botId: "bot_1", botName: "Scout", threadId: "thr_1" },
    });
    expect(first).toEqual({ kind: "sent", status: 200, apnsId: "apns-ok-1" });
    expect(seenAuth).toHaveLength(2);
    expect(seenAuth[0]).not.toBe(seenAuth[1]);

    clock += 60_000;
    await client.sendAlert(config, "sandbox", {
      v: 1,
      token: "a".repeat(64),
      notification: { kind: "done", title: "Scout finished", botId: "bot_1", botName: "Scout", threadId: "thr_1" },
    });
    expect(seenAuth[2]).toBe(seenAuth[1]);

    clock += APNS_TOKEN_WINDOW_MS;
    await client.sendAlert(config, "sandbox", {
      v: 1,
      token: "a".repeat(64),
      notification: { kind: "done", title: "Scout finished", botId: "bot_1", botName: "Scout", threadId: "thr_1" },
    });
    expect(seenAuth[3]).not.toBe(seenAuth[2]);
  });

  it("delivers alert and Live Activity pushes over real HTTP/2 and flags 410 dead tokens", async () => {
    const { privateKeyPem } = makeTestP8KeyPair();
    const config = resolveApnsConfig({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      bundleId: "com.example.mausbot",
      privateKey: privateKeyPem,
    })!;

    const received: Array<{ path: string; headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
    const server = http2.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        received.push({ path: req.url ?? "", headers: req.headers, body });
        if ((req.url ?? "").endsWith("dead".padEnd(64, "0"))) {
          res.writeHead(410, { "content-type": "application/json" });
          res.end(JSON.stringify({ reason: "Unregistered", timestamp: 1_700_000_000_000 }));
          return;
        }
        res.writeHead(200, { "apns-id": "h2-uuid-1" });
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;

    const client = new ApnsDirectClient({ hosts: { sandbox: origin, production: origin }, now: () => 1_700_000_000_000 });
    try {
      const alertOutcome = await client.sendAlert(config, "sandbox", {
        v: 1,
        token: "b".repeat(64),
        collapseId: "col_1",
        notification: { kind: "question", title: "Scout has a question", botId: "bot_1", botName: "Scout", threadId: "thr_1" },
      });
      expect(alertOutcome).toEqual({ kind: "sent", status: 200, apnsId: "h2-uuid-1" });
      expect(received[0]?.headers["apns-topic"]).toBe("com.example.mausbot");
      expect(received[0]?.headers["apns-push-type"]).toBe("alert");
      expect(received[0]?.body).toMatchObject({
        aps: { alert: { title: "Scout has a question" }, category: "OPENMAUS_QUESTION", "interruption-level": "time-sensitive" },
        omb: { v: 1, kind: "question", botId: "bot_1", threadId: "thr_1" },
        body: { v: 1, kind: "question", botId: "bot_1", threadId: "thr_1" },
      });

      const activityOutcome = await client.sendActivity(config, "sandbox", {
        v: 1,
        token: "c".repeat(64),
        event: "start",
        alert: true,
        activity: {
          version: 1,
          ask: "approval",
          status: "Needs your approval",
          waiting: 1,
          botId: "bot_1",
          botName: "Scout",
          kind: "needsYou",
          headline: "Scout needs you",
          since: 1_700_000_000_000,
          link: "openmausbot://chat/thr_1",
          color: "#7C5CFF",
          gradient: ["#7C5CFF"],
          body: "cursor",
        },
      });
      expect(activityOutcome).toEqual({ kind: "sent", status: 200, apnsId: "h2-uuid-1" });
      expect(received[1]?.headers["apns-topic"]).toBe("com.example.mausbot.push-type.liveactivity");
      expect(received[1]?.headers["apns-push-type"]).toBe("liveactivity");
      expect(received[1]?.headers["apns-priority"]).toBe("10");

      const deadOutcome = await client.sendAlert(config, "sandbox", {
        v: 1,
        token: "dead".padEnd(64, "0"),
        notification: { kind: "done", title: "Done", botId: "bot_1", botName: "Scout", threadId: "thr_1" },
      });
      expect(deadOutcome).toEqual({ kind: "dead", status: 410, reason: "Unregistered", invalidSince: 1_700_000_000_000 });
    } finally {
      client.close();
    }
  });

  it("classifies HTTP 400 TopicDisallowed and BadTopic as credential errors", async () => {
    const { privateKeyPem } = makeTestP8KeyPair();
    const config = resolveApnsConfig({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      bundleId: "com.example.mausbot",
      privateKey: privateKeyPem,
      environment: "sandbox",
    })!;
    for (const reason of ["TopicDisallowed", "BadTopic"]) {
      const client = new ApnsDirectClient({
        transport: async () => ({ status: 400, body: JSON.stringify({ reason }) }),
      });
      const outcome = await client.sendAlert(config, "sandbox", {
        v: 1,
        token: "a".repeat(64),
        notification: { kind: "done", title: "Done", botId: "bot_1", botName: "Scout", threadId: "thr_1" },
      });
      expect(outcome).toEqual({ kind: "credentials", status: 400, reason });
    }
  });

  it("evicts and destroys a timed-out HTTP/2 session so subsequent requests reconnect cleanly", async () => {
    let sessionsSeen = 0;
    let requestsSeen = 0;
    const server = http2.createServer();
    server.on("session", () => {
      sessionsSeen += 1;
    });
    server.on("request", (_req, res) => {
      requestsSeen += 1;
      if (requestsSeen === 1) {
        return;
      }
      res.writeHead(200, { "apns-id": "recovered-1" });
      res.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const pool = new Http2SessionPool();
    try {
      await expect(pool.send({
        origin,
        path: "/3/device/aa",
        headers: { "content-type": "application/json" },
        body: "{}",
        timeoutMs: 60,
      })).rejects.toThrow(/APNs request timed out/);

      const second = await pool.send({
        origin,
        path: "/3/device/aa",
        headers: { "content-type": "application/json" },
        body: "{}",
        timeoutMs: 2_000,
      });
      expect(second.status).toBe(200);
      expect(second.apnsId).toBe("recovered-1");
      expect(sessionsSeen).toBe(2);
    } finally {
      pool.close();
    }
  });

  it("builds 3-line rich alerts, silent working push-to-start, capsule answer pills, and idle checkmark state", () => {
    const richAlert = buildApnsAlertPayload({
      v: 1,
      token: "a".repeat(64),
      alertSubtitle: "Fix iOS notifications",
      alertBody: "Build failed on step 3",
      notification: { kind: "turn-failed", title: "Scout hit an error", botId: "bot_1", botName: "Scout", threadId: "thr_1" },
    });
    expect(richAlert.aps).toMatchObject({
      alert: {
        title: "Scout hit an error",
        subtitle: "Fix iOS notifications",
        body: "Build failed on step 3",
      },
      "mutable-content": 1,
      sound: "default",
      "interruption-level": "time-sensitive",
    });

    const mausBotNamedAlert = buildApnsAlertPayload({
      v: 1,
      token: "a".repeat(64),
      alertSubtitle: "Audit PR #42",
      alertBody: "All checks passed",
      botVisual: {
        color: "#788B9D",
        gradient: ["#E2E8F0", "#788B9D", "#334155"],
        body: "cursor",
        faceInk: "#1E2833",
        mood: "unread",
      },
      notification: { kind: "done", title: "MausBot", botId: "bot_0", botName: "MausBot", threadId: "thr_0" },
    });
    expect(mausBotNamedAlert.aps).toMatchObject({
      alert: {
        title: "MausBot\u2060",
        subtitle: "Audit PR #42",
        body: "All checks passed",
      },
      "mutable-content": 1,
    });
    expect((mausBotNamedAlert.aps.alert as { title: string }).title).not.toBe("MausBot");
    expect(mausBotNamedAlert.omb).toMatchObject({
      botId: "bot_0",
      botName: "MausBot",
      statusTitle: "MausBot",
      botVisual: {
        color: "#788B9D",
        body: "cursor",
        faceInk: "#1E2833",
        mood: "unread",
      },
    });

    const mausBotSilentStart = buildApnsLiveActivityPayload({
      v: 1,
      token: "b".repeat(64),
      event: "start",
      silentStartAlert: true,
      activity: {
        version: 1,
        ask: "other",
        status: "Running · pnpm test",
        waiting: 0,
        botId: "bot_0",
        botName: "MausBot",
        kind: "working",
        headline: "MausBot is working",
        since: 1_700_000_000_000,
        link: "openmausbot://chat/thr_0",
        color: "#788B9D",
        gradient: ["#788B9D"],
        body: "cursor",
      },
    }, 1_700_000_000_000);
    expect(mausBotSilentStart.aps.alert).toEqual({ title: "MausBot is working", body: "Running · pnpm test" });

    const silentStart = buildApnsLiveActivityPayload({
      v: 1,
      token: "b".repeat(64),
      event: "start",
      silentStartAlert: true,
      activity: {
        version: 1,
        ask: "other",
        status: "Running · pnpm test",
        waiting: 0,
        botId: "bot_1",
        botName: "Scout",
        kind: "working",
        headline: "Scout is working",
        since: 1_700_000_000_000,
        link: "openmausbot://chat/thr_1",
        color: "#7C5CFF",
        gradient: ["#7C5CFF"],
        body: "round",
      },
    }, 1_700_000_000_000);
    expect(silentStart.aps.alert).toEqual({ title: "Scout", body: "Running · pnpm test" });
    expect("sound" in (silentStart.aps.alert as Record<string, unknown>)).toBe(false);

    const needsYouPayload = buildApnsLiveActivityPayload({
      v: 1,
      token: "c".repeat(64),
      event: "update",
      activity: {
        version: 1,
        ask: "approval",
        status: "Needs approval · rm -rf dist",
        waiting: 1,
        botId: "bot_1",
        botName: "Scout",
        kind: "needsYou",
        headline: "Scout needs you",
        since: 1_700_000_000_000,
        link: "openmausbot://chat/thr_1",
        color: "#7C5CFF",
        gradient: ["#7C5CFF"],
        body: "round",
        answers: [
          { label: "View chat", link: "openmausbot://chat/thr_1?from=island", refusal: true },
          { label: "Review", link: "openmausbot://chat/thr_1?focus=approval", refusal: false },
          { label: "Extra ignored", link: "openmausbot://chat/thr_1", refusal: false },
        ],
      },
    }, 1_700_000_000_000);
    const needsYouProps = JSON.parse((needsYouPayload.aps["content-state"] as { props: string }).props);
    expect(needsYouProps.mood).toBe("needsYou");
    expect(needsYouProps.answers).toHaveLength(2);
    expect(needsYouProps.answers[1]).toEqual({ label: "Review", link: "openmausbot://chat/thr_1?focus=approval", refusal: false });

    const idleCompletion = buildApnsLiveActivityPayload({
      v: 1,
      token: "d".repeat(64),
      event: "update",
      staleSeconds: 60,
      activity: {
        version: 1,
        ask: "other",
        status: "Finished · All 42 tests passed",
        waiting: 0,
        botId: "bot_1",
        botName: "Scout",
        kind: "idle",
        headline: "Scout finished",
        since: 1_700_000_000_000,
        link: "openmausbot://chat/thr_1",
        color: "#7C5CFF",
        gradient: ["#7C5CFF"],
        body: "round",
      },
    }, 1_700_000_000_000);
    const idleProps = JSON.parse((idleCompletion.aps["content-state"] as { props: string }).props);
    expect(idleProps).toMatchObject({ kind: "idle", mood: "idle", status: "Finished · All 42 tests passed" });
    expect((idleCompletion.aps as Record<string, unknown>)["stale-date"]).toBe(1_700_000_060);
  });
});
