import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveApnsConfig } from "./apns-config.ts";
import { ApnsDirectClient, type ApnsRawRequest } from "./apns-direct.ts";
import { activityRegistrationSchema, FALLBACK_VISUAL, PhoneActivity } from "./phone-activity.ts";
import { PhonePush } from "./phone-push.ts";

const CREDENTIAL = `omb_install_${"a".repeat(22)}.${"b".repeat(43)}`;
const START = "5a".repeat(40);
const ACT = "ac".repeat(40);
const FCM = `fcmInstance_1:APA91b${"x".repeat(140)}`;
const IPHONE = "session:iphone";
const ANDROID = "companion:android";
const VISUAL = { color: "#7C5CFF", gradient: ["#B9A9FF", "#7C5CFF", "#48369A"], body: "round" };
const HEADLINES = { needsYou: "{name} needs you", working: "{name} is working" };

interface Call { path: string; body: Record<string, unknown> }

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-phone-activity-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function harness(options: { enabled?: boolean; available?: boolean; live?: Set<string>; openAsks?: Set<string>; answers?: Array<{ status: number; error?: string }> } = {}) {
  const calls: Call[] = [];
  const answers = [...(options.answers ?? [])];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    const answer = path.endsWith("/activity") ? answers.shift() : undefined;
    const status = answer?.status ?? (path.endsWith("/unregister") ? 204 : path.endsWith("/register") ? 200 : 202);
    return new Response(answer?.error ? JSON.stringify({ error: answer.error }) : status === 204 ? null : "{}", { status });
  }) as typeof fetch;
  const live = options.live ?? new Set<string>();
  const push = new PhonePush({
    dataDir,
    access: () => ({ controlPlane: "https://accounts.openmausbot.test", credential: CREDENTIAL }),
    enabled: () => options.enabled ?? true,
    live: (key) => live.has(key),
    room: () => undefined,
    fetchImpl,
    log: () => {},
  });
  const openAsks = options.openAsks ?? new Set<string>();
  const bots = new Map<string, { name: string; busy: boolean; threadId: string }>([["bot_1", { name: "Scout", busy: false, threadId: "th_1" }]]);
  let clock = 1_000_000;
  const activity = new PhoneActivity({
    dataDir, push, hasOpenAsk: (botId) => openAsks.has(botId), bot: (botId) => bots.get(botId), botOfThread: (threadId) => (threadId.startsWith("th_") ? "bot_1" : undefined),
    now: () => clock, log: () => {}, timers: { set: () => ({}), clear: () => {} },
    ...(options.available === undefined ? {} : { available: () => options.available! }),
  });
  const activityCalls = () => calls.filter((call) => call.path.endsWith("/push/activity")).map((call) => call.body);
  /** The bot works (or stops), a frame says so, and its frames settle. */
  const step = async (change: { busy?: boolean; ask?: boolean; name?: string }, payload: Record<string, unknown> = { kind: "bot", bot: { id: "bot_1" } }, reaches: (key: string) => boolean = () => true) => {
    const bot = bots.get("bot_1")!;
    bots.set("bot_1", { ...bot, ...(change.busy === undefined ? {} : { busy: change.busy }), ...(change.name ? { name: change.name } : {}) });
    if (change.ask === true) openAsks.add("bot_1");
    if (change.ask === false) openAsks.delete("bot_1");
    activity.offer(payload, reaches);
    await activity.flushNow();
  };
  return { push, activity, calls, activityCalls, live, openAsks, step, tick: (ms: number) => { clock += ms; } };
}

const registration = (extra: Record<string, unknown> = {}) => activityRegistrationSchema.parse({ scheme: "openmausbot", headlines: HEADLINES, ...extra });
const notify = (kind: string) => ({ kind: "notify", notification: { kind, botId: "bot_1", botName: "Scout", threadId: "th_ask", title: "Scout needs approval", body: "PRIVATE run cat ~/payroll.csv" } });
const runtime = (type: string) => ({ kind: "runtime", event: { type, threadId: "th_1", eventId: "e1", provider: "claudeAgent", createdAt: "" } });
const everyone = () => true;

describe("registering a phone's activities", () => {
  it("keeps nothing while phone push is off", async () => {
    const { activity, calls, step } = harness({ enabled: false });
    expect(await activity.register(IPHONE, registration({ startToken: START }))).toBe("off");
    expect(activity.registration(IPHONE)).toBeNull();
    await step({ busy: true });
    expect(calls).toEqual([]);
  });

  it("is not offered where a bot's state is everyone's (a Team Cloud): keeps nothing, registers nothing, pushes nothing", async () => {
    const { activity, calls, step } = harness({ available: false, live: new Set() });
    expect(await activity.register(IPHONE, registration({ startToken: START, activities: [{ botId: "bot_1", token: ACT }] }))).toBe("off");
    expect(activity.registration(IPHONE)).toBeNull();
    await step({ ask: true }, notify("approval"), everyone);
    await step({ busy: true }, runtime("turn.started"), everyone);
    await step({ busy: false, ask: false }, runtime("turn.completed"), everyone);
    expect(calls).toEqual([]);
  });

  it("registers the push-to-start and activity tokens with their purpose, never echoes them, and drops replaced ones", async () => {
    const { activity, calls } = harness();
    await activity.register(IPHONE, registration({ startToken: START, activities: [{ botId: "bot_1", token: ACT }], visuals: { bot_1: VISUAL } }));
    expect(calls.map((call) => call.body)).toEqual([
      { v: 1, platform: "apns", purpose: "activity-start", token: START, environment: "production" },
      { v: 1, platform: "apns", purpose: "activity", token: ACT, environment: "production" },
    ]);
    expect(activity.registration(IPHONE)).toEqual({ scheme: "openmausbot", headlines: HEADLINES, ongoing: false, kinds: ["needsYou", "working"], activities: ["bot_1"], canStart: true });
    expect(JSON.stringify(activity.registration(IPHONE))).not.toContain(ACT);
    await activity.register(IPHONE, registration({ startToken: START }));
    expect(calls.at(-1)).toEqual({ path: "/v1/installations/self/push/unregister", body: { v: 1, platform: "apns", token: ACT } });
  });

  it("takes only its own words with a place for the name, and well-formed tokens and colours", () => {
    for (const bad of [
      { headlines: { needsYou: "needs you", working: "{name} is working" } },
      { headlines: { needsYou: "{name}\nneeds you", working: "{name} is working" } },
      { startToken: FCM },
      { visuals: { bot_1: { ...VISUAL, color: "purple" } } },
      { scheme: "https" },
      { activities: Array.from({ length: 11 }, (_, index) => ({ botId: `b${index}`, token: ACT })) },
      { line: "text" },
    ]) expect(activityRegistrationSchema.safeParse({ scheme: "openmausbot", headlines: HEADLINES, ...bad }).success, JSON.stringify(bad)).toBe(false);
  });
});

describe("pushing a bot's activity while the app is closed", () => {
  it("updates a running activity as the bot starts and stops working, once per change, then forgets its token", async () => {
    const { activity, activityCalls, calls, step } = harness();
    await activity.register(IPHONE, registration({ activities: [{ botId: "bot_1", token: ACT }], visuals: { bot_1: VISUAL } }));
    await step({ busy: true }, runtime("turn.started"));
    await step({}, runtime("turn.started"));
    await step({ busy: false }, runtime("turn.completed"));
    expect(activityCalls()).toEqual([
      { v: 1, token: ACT, event: "update", activity: { botId: "bot_1", botName: "Scout", kind: "working", headline: "Scout is working", since: 1_000_000, link: "openmausbot://chat/th_1", ...VISUAL } },
      { v: 1, token: ACT, event: "end", activity: { botId: "bot_1", botName: "Scout", kind: "working", headline: "Scout is working", since: 1_000_000, link: "openmausbot://chat/th_1", ...VISUAL } },
    ]);
    expect(calls.at(-1)).toMatchObject({ path: "/v1/installations/self/push/unregister", body: { token: ACT } });
    expect(activity.registration(IPHONE)?.activities).toEqual([]);
  });

  it("rings when a bot starts needing the person, and starts an activity remotely only then", async () => {
    const { activity, activityCalls, step } = harness();
    await activity.register(IPHONE, registration({ startToken: START }));
    await step({ busy: true });
    await step({ ask: true }, notify("approval"));
    await step({}, notify("done"));
    expect(activityCalls()).toEqual([
      { v: 1, token: START, event: "start", alert: true, activity: { botId: "bot_1", botName: "Scout", kind: "needsYou", headline: "Scout needs you", since: 1_000_000, link: "openmausbot://chat/th_ask", ...FALLBACK_VISUAL } },
    ]);
    expect(JSON.stringify(activityCalls())).not.toContain("payroll");
  });

  it("drives Android's ongoing notification through the phone's FCM token", async () => {
    const { push, activity, activityCalls, step } = harness();
    await push.register(ANDROID, { platform: "fcm", token: FCM });
    await activity.register(ANDROID, registration({ ongoing: true }));
    await step({ busy: true });
    await step({ ask: true }, runtime("request.opened"));
    await step({ ask: false, busy: false }, runtime("turn.completed"));
    expect(activityCalls().map((body) => [body.token === FCM, body.event, (body.activity as { kind: string }).kind, body.alert ?? false])).toEqual([
      [true, "update", "working", false],
      [true, "update", "needsYou", false],
      [true, "end", "needsYou", false],
    ]);
  });

  it("leaves a connected phone to its own app, and a phone that may not see the bot alone", async () => {
    const { activity, activityCalls, live, step } = harness();
    await activity.register(IPHONE, registration({ activities: [{ botId: "bot_1", token: ACT }] }));
    live.add(IPHONE);
    await step({ busy: true });
    live.delete(IPHONE);
    await step({}, undefined, () => false);
    expect(activityCalls()).toEqual([]);
    await step({});
    expect(activityCalls()).toHaveLength(1);
    await step({}, { kind: "runtime", event: { type: "content.delta", threadId: "th_1" } });
    await step({}, { kind: "message", threadId: "th_1" });
    expect(activityCalls()).toHaveLength(1);
  });

  it("honours the kinds the phone asked for", async () => {
    const { activity, activityCalls, step } = harness();
    await activity.register(IPHONE, registration({ kinds: ["needsYou"], activities: [{ botId: "bot_1", token: ACT }] }));
    await step({ busy: true });
    await step({ busy: true }, runtime("turn.started"));
    // Never an update for a kind the phone did not ask for; only the one end for what its app may have drawn.
    expect(activityCalls().map((body) => body.event)).toEqual(["end"]);
  });

  it("sends every change, however many: no hourly cap holds them back", async () => {
    const { push, activity, activityCalls, calls, step } = harness();
    await push.register(ANDROID, { platform: "fcm", token: FCM });
    await activity.register(ANDROID, registration({ ongoing: true }));
    for (let change = 0; change < 100; change += 1) await step({ busy: change % 2 === 0 }, runtime(change % 2 === 0 ? "turn.started" : "turn.completed"));
    expect(activityCalls()).toHaveLength(100);
    push.offer({ notification: { kind: "approval", botId: "bot_1", botName: "Scout", threadId: "th_1" }, seq: 1 }, everyone);
    await push.flush();
    expect(calls.filter((call) => call.path.endsWith("/push/send"))).toHaveLength(1);
  });

  it("drops an activity token the provider calls dead", async () => {
    const { activity, step } = harness({ answers: [{ status: 410, error: "push_device_unregistered" }] });
    await activity.register(IPHONE, registration({ activities: [{ botId: "bot_1", token: ACT }] }));
    await step({ busy: true });
    expect(activity.registration(IPHONE)?.activities).toEqual([]);
  });

  it("forgets a phone and its tokens when it is unpaired", async () => {
    const { activity, calls } = harness();
    await activity.register(IPHONE, registration({ startToken: START, activities: [{ botId: "bot_1", token: ACT }] }));
    await activity.remove(IPHONE);
    expect(calls.filter((call) => call.path.endsWith("/unregister")).map((call) => call.body.token)).toEqual([START, ACT]);
    expect(activity.registration(IPHONE)).toBeNull();
  });

  it("never throws into the server", () => {
    const { activity } = harness();
    expect(() => activity.offer({ kind: "bot", bot: null }, everyone)).not.toThrow();
    expect(() => activity.offer({ kind: "notify", notification: "x" }, everyone)).not.toThrow();
  });

  it("ends what the app drew for a bot that went quiet after the phone's stream closed, once", async () => {
    const { push, activity, activityCalls, live, step } = harness();
    await push.register(ANDROID, { platform: "fcm", token: FCM });
    await activity.register(ANDROID, registration({ ongoing: true }));
    await activity.register(IPHONE, registration({}));
    live.add(ANDROID);
    await step({ busy: true });
    live.delete(ANDROID);
    await step({ busy: false });
    await step({ busy: false });
    expect(activityCalls().map((body) => [body.token === FCM, body.event])).toEqual([[true, "end"]]);
  });

  it("never alerts a running activity's update, only a remote start", async () => {
    const { activity, activityCalls, step } = harness();
    await activity.register(IPHONE, registration({ activities: [{ botId: "bot_1", token: ACT }], startToken: START }));
    await step({ busy: true });
    await step({ ask: true }, notify("approval"));
    expect(activityCalls().map((body) => [body.token === ACT, body.event, (body.activity as { kind: string }).kind, "alert" in body])).toEqual([
      [true, "update", "working", false],
      [true, "update", "needsYou", false],
    ]);
  });

  it("sends content state version 1, in the phone's words for the ask, only to a phone that registered them", async () => {
    const { activity, activityCalls, step } = harness();
    const statuses = { working: "Working", needsYou: { approval: "Needs your approval", question: "Has a question", signIn: "Needs you to sign in", other: "Needs you" } };
    await activity.register(IPHONE, registration({ activities: [{ botId: "bot_1", token: ACT }], statuses }));
    await activity.register(ANDROID, registration({ activities: [{ botId: "bot_1", token: START }] }));
    await step({ busy: true });
    await step({ ask: true }, notify("sign-in"));
    const sent = activityCalls().map((body) => [body.token, body.activity as Record<string, unknown>] as const);
    const v1 = sent.filter(([token]) => token === ACT).map(([, body]) => [body.version, body.ask, body.status, body.waiting]);
    expect(v1).toEqual([[1, "other", "Working", 0], [1, "signIn", "Needs you to sign in", 1]]);
    const earlier = sent.filter(([token]) => token === START).map(([, body]) => body);
    expect(earlier).toHaveLength(2);
    for (const body of earlier) expect(["version", "ask", "status", "waiting"].some((field) => field in body)).toBe(false);
    expect(activityRegistrationSchema.safeParse({ scheme: "openmausbot", headlines: HEADLINES, statuses: { ...statuses, working: "Work\ning" } }).success).toBe(false);
  });

  it("drives the full Direct APNs Dynamic Island lifecycle: debounced working start, throttled tool progress, needsYou pills, and idle checkmark linger", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = String(privateKey.export({ type: "pkcs8", format: "pem" })).trim();
    const apnsCalls: ApnsRawRequest[] = [];
    let clock = 2_000_000;
    const apnsClient = new ApnsDirectClient({
      now: () => clock,
      transport: async (req) => {
        apnsCalls.push(req);
        return { status: 200, apnsId: "apns-island", body: "" };
      },
    });
    const push = new PhonePush({
      dataDir,
      access: () => null,
      apns: () => resolveApnsConfig({
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        bundleId: "com.example.mausbot",
        privateKey: pem,
        environment: "sandbox",
        includePreview: true,
      }),
      apnsClient,
      enabled: () => true,
      live: () => false,
      room: () => undefined,
      threadTitle: () => "修復 iOS 動態島",
      now: () => clock,
      log: () => {},
    });
    const openAsks = new Set<string>();
    const bots = new Map([["bot_1", { name: "Scout", busy: false, threadId: "th_1" }]]);
    const activity = new PhoneActivity({
      dataDir,
      push,
      hasOpenAsk: (botId) => openAsks.has(botId),
      bot: (botId) => bots.get(botId),
      botOfThread: () => "bot_1",
      now: () => clock,
      log: () => {},
      timers: { set: () => ({}), clear: () => {} },
    });

    await push.register(IPHONE, { platform: "apns", token: "ab".repeat(32), environment: "sandbox" });
    await activity.register(IPHONE, activityRegistrationSchema.parse({
      scheme: "openmausbot",
      headlines: { needsYou: "{name} 需要你處理", working: "{name} 正在處理" },
      statuses: {
        working: "處理中",
        needsYou: { approval: "等待你核准", question: "有個問題想問你", signIn: "需要你登入", other: "需要你處理" },
      },
      startToken: START,
      visuals: { bot_1: VISUAL },
    }));

    // 1. Fast turn (< 1.5s) never starts a Dynamic Island session.
    bots.set("bot_1", { name: "Scout", busy: true, threadId: "th_1" });
    activity.offer(runtime("turn.started"), everyone);
    await activity.flushNow();
    expect(apnsCalls).toHaveLength(0);
    clock += 800;
    bots.set("bot_1", { name: "Scout", busy: false, threadId: "th_1" });
    activity.offer(runtime("turn.completed"), everyone);
    await activity.flushNow();
    clock += 2_000;
    await activity.flushNow();
    expect(apnsCalls).toHaveLength(0);

    // 2. Real turn (> 1.5s) push-starts Dynamic Island silently with task context.
    bots.set("bot_1", { name: "Scout", busy: true, threadId: "th_1" });
    activity.offer(runtime("turn.started"), everyone);
    await activity.flushNow();
    clock += 1_600;
    await activity.flushNow();
    expect(apnsCalls).toHaveLength(1);
    expect(apnsCalls[0]!.path).toBe(`/3/device/${START}`);
    const startPayload = JSON.parse(apnsCalls[0]!.body);
    expect(startPayload.aps.event).toBe("start");
    expect("sound" in (startPayload.aps.alert ?? {})).toBe(false);
    expect(JSON.parse(startPayload.aps["content-state"].props)).toMatchObject({
      kind: "working",
      mood: "working",
      status: "處理中 · 修復 iOS 動態島",
    });

    // 3. iPhone registers its per-activity token and receives live tool step progress (throttled to 6s).
    activity.offer({
      kind: "runtime",
      event: { type: "turn.progress", threadId: "th_1", activity: "command", target: "pnpm test" },
    }, everyone);
    await activity.flushNow();
    await activity.register(IPHONE, activityRegistrationSchema.parse({
      scheme: "openmausbot",
      headlines: { needsYou: "{name} 需要你處理", working: "{name} 正在處理" },
      statuses: {
        working: "處理中",
        needsYou: { approval: "等待你核准", question: "有個問題想問你", signIn: "需要你登入", other: "需要你處理" },
      },
      startToken: START,
      activities: [{ botId: "bot_1", token: ACT }],
      visuals: { bot_1: VISUAL },
    }));
    await activity.flushNow();
    expect(apnsCalls).toHaveLength(2);
    expect(JSON.parse(JSON.parse(apnsCalls[1]!.body).aps["content-state"].props)).toMatchObject({
      kind: "working",
      status: "執行 · pnpm test",
    });

    // Immediate next tool progress within 6s is throttled, then flushed once 6s elapses.
    clock += 1_000;
    activity.offer({
      kind: "runtime",
      event: { type: "item.started", threadId: "th_1", itemType: "tool", step: { activity: "edit", target: "server/phone-activity.ts" } },
    }, everyone);
    await activity.flushNow();
    expect(apnsCalls).toHaveLength(2);
    clock += 5_500;
    await activity.flushNow();
    expect(apnsCalls).toHaveLength(3);
    expect(JSON.parse(JSON.parse(apnsCalls[2]!.body).aps["content-state"].props)).toMatchObject({
      kind: "working",
      status: "編輯 · phone-activity.ts",
    });

    // 4. Approval ask transitions to needsYou with detail + 2 localized deep-link capsule pills.
    openAsks.add("bot_1");
    activity.offer({
      kind: "notify",
      notification: { kind: "approval", botId: "bot_1", botName: "Scout", threadId: "th_1", title: "Approve", body: "rm -rf dist" },
    }, everyone);
    await activity.flushNow();
    expect(apnsCalls).toHaveLength(4);
    const askProps = JSON.parse(JSON.parse(apnsCalls[3]!.body).aps["content-state"].props);
    expect(askProps).toMatchObject({
      kind: "needsYou",
      mood: "needsYou",
      status: "等待你核准 · rm -rf dist",
      waiting: 1,
    });
    expect(askProps.answers).toEqual([
      { label: "查看對話", link: "openmausbot://chat/th_1?from=island", refusal: true },
      { label: "前往核准", link: "openmausbot://chat/th_1?focus=approval", refusal: false },
    ]);

    // 5. Turn completion shows idle checkmark (`✓`) with reply summary for 30s, then ends cleanly.
    openAsks.delete("bot_1");
    bots.set("bot_1", { name: "Scout", busy: false, threadId: "th_1" });
    activity.offer({
      kind: "notify",
      notification: { kind: "done", botId: "bot_1", botName: "Scout", threadId: "th_1", title: "Scout 已完成", body: "全部測試皆已通過" },
    }, everyone);
    await activity.flushNow();
    expect(apnsCalls).toHaveLength(5);
    const idlePayload = JSON.parse(apnsCalls[4]!.body);
    expect(idlePayload.aps.event).toBe("update");
    expect(JSON.parse(idlePayload.aps["content-state"].props)).toMatchObject({
      kind: "idle",
      mood: "idle",
      status: "已完成 · 全部測試皆已通過",
    });

    clock += 29_000;
    await activity.flushNow();
    expect(apnsCalls).toHaveLength(5);

    clock += 1_500;
    await activity.flushNow();
    expect(apnsCalls).toHaveLength(6);
    expect(JSON.parse(apnsCalls[5]!.body).aps.event).toBe("end");
    expect(activity.registration(IPHONE)?.activities).toEqual([]);
  });

  it("attaches a background push-started token via POST, preserves it across empty background PUTs without re-flashing startToken, and lingers 30s on brief/routine completion", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateKeyPem = String(privateKey.export({ type: "pkcs8", format: "pem" })).trim();
    const resolved = resolveApnsConfig({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      bundleId: "com.example.mausbot",
      privateKey: privateKeyPem,
      environment: "sandbox",
      includePreview: true,
    })!;
    let clock = 2_000_000;
    const apnsCalls: ApnsRawRequest[] = [];
    const apnsClient = new ApnsDirectClient({
      now: () => clock,
      transport: async (req) => {
        apnsCalls.push(req);
        return { status: 200, apnsId: `apns-bg-${apnsCalls.length}`, body: "" };
      },
    });
    const push = new PhonePush({
      dataDir,
      access: () => null,
      apns: () => resolved,
      apnsClient,
      enabled: () => true,
      live: () => false,
      room: () => undefined,
      threadTitle: () => "九點打卡簽到",
      now: () => clock,
      log: () => {},
    });
    const bots = new Map([["bot_1", { name: "MausBot", busy: false, threadId: "th_1" }]]);
    const activity = new PhoneActivity({
      dataDir,
      push,
      hasOpenAsk: () => false,
      bot: (botId) => bots.get(botId),
      botOfThread: () => "bot_1",
      now: () => clock,
      log: () => {},
      timers: { set: () => ({}), clear: () => {} },
    });

    await push.register(IPHONE, { platform: "apns", token: "ab".repeat(32), environment: "sandbox" });
    const baseReg = {
      scheme: "openmausbot" as const,
      headlines: { needsYou: "{name} 需要你處理", working: "{name} 正在處理" },
      statuses: {
        working: "處理中",
        needsYou: { approval: "等待你核准", question: "有個問題想問你", signIn: "需要你登入", other: "需要你處理" },
      },
      startToken: START,
      visuals: { bot_1: VISUAL },
    };
    await activity.register(IPHONE, activityRegistrationSchema.parse(baseReg));

    // Scheduled turn starts -> 1.5s later Mac sends exactly one push-to-start.
    bots.set("bot_1", { name: "MausBot", busy: true, threadId: "th_1" });
    activity.offer(runtime("turn.started"), everyone);
    await activity.flushNow();
    clock += 1_600;
    await activity.flushNow();
    expect(apnsCalls).toHaveLength(1);
    expect(apnsCalls[0]!.path).toBe(`/3/device/${START}`);
    expect(JSON.parse(apnsCalls[0]!.body).aps.event).toBe("start");

    // Step progress arrives before ActivityKit finishes minting per-activity token.
    clock += 800;
    activity.offer({
      kind: "runtime",
      event: { type: "turn.progress", threadId: "th_1", activity: "fetch", target: "portal.nueip.com" },
    }, everyone);
    await activity.flushNow();

    // iOS background bridge POSTs the newly minted push-started token -> immediately receives step update.
    expect(await activity.attachPushStartedToken(IPHONE, { token: ACT, activityId: "act-uuid-1" })).toBe("attached");
    await activity.flushNow();
    expect(apnsCalls).toHaveLength(2);
    expect(apnsCalls[1]!.path).toBe(`/3/device/${ACT}`);
    expect(JSON.parse(JSON.parse(apnsCalls[1]!.body).aps["content-state"].props)).toMatchObject({
      kind: "working",
      status: "擷取網頁 · portal.nueip.com",
    });

    // Unpatched JS coordinator sends PUT /api/push/activity with activities: [] after 35s (> 30s dedup window):
    // server preserves ACT and NEVER sends a second push-to-start for this turn.
    clock += 35_000;
    await activity.register(IPHONE, activityRegistrationSchema.parse({ ...baseReg, activities: [] }));
    activity.offer({
      kind: "runtime",
      event: { type: "turn.progress", threadId: "th_1", activity: "command", target: "submit-checkin" },
    }, everyone);
    await activity.flushNow();
    expect(apnsCalls.filter((call) => call.path === `/3/device/${START}`)).toHaveLength(1);
    expect(apnsCalls).toHaveLength(3);
    expect(apnsCalls[2]!.path).toBe(`/3/device/${ACT}`);
    expect(JSON.parse(JSON.parse(apnsCalls[2]!.body).aps["content-state"].props)).toMatchObject({
      kind: "working",
      status: "執行 · submit-checkin",
    });

    // Routine brief completion transitions Dynamic Island to `✓ 已完成` for 30s, then ends cleanly.
    clock += 10_000;
    bots.set("bot_1", { name: "MausBot", busy: false, threadId: "th_1" });
    activity.offer({
      kind: "notify",
      notification: { kind: "brief", botId: "bot_1", botName: "MausBot", threadId: "th_1", title: "MausBot 已完成", body: "09:01 已完成簽到打卡" },
    }, everyone);
    await activity.flushNow();
    expect(apnsCalls).toHaveLength(4);
    expect(JSON.parse(JSON.parse(apnsCalls[3]!.body).aps["content-state"].props)).toMatchObject({
      kind: "idle",
      mood: "idle",
      status: "已完成 · 09:01 已完成簽到打卡",
    });

    clock += 30_500;
    await activity.flushNow();
    expect(apnsCalls).toHaveLength(5);
    expect(JSON.parse(apnsCalls[4]!.body).aps.event).toBe("end");
    expect(activity.registration(IPHONE)?.activities).toEqual([]);
  });
});
