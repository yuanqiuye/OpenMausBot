import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSigningEntitlements,
  extractPlistEntitlements,
  injectMachOLoadDylib,
  patchExtractedAppBundle,
  plistToJson,
  validateProvisionEntitlements,
  writePlistFromObject,
} from "./resign-ipa-apns.mjs";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe.runIf(process.platform === "darwin")("resign-ipa-apns bundle patcher", () => {
  it("enables remotePush + Live Activity push tokens, aligns App Group & Keychain groups, and strips share extension when requested", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-ipa-patch-test-"));
    tempDirs.push(root);
    const appDir = join(root, "Payload", "MausBot.app");
    mkdirSync(join(appDir, "EXConstants.bundle"), { recursive: true });
    mkdirSync(join(appDir, "PlugIns", "ExpoWidgetsTarget.appex"), { recursive: true });
    mkdirSync(join(appDir, "PlugIns", "expo-sharing-extension.appex"), { recursive: true });

    writePlistFromObject(join(appDir, "Info.plist"), {
      CFBundleIdentifier: "com.openmausbot.app",
      OpenMausAppGroup: "group.com.openmausbot.shared",
      ExpoWidgetsAppGroupIdentifier: "group.com.openmausbot.shared",
      ExpoShareIntoAppGroupId: "group.com.openmausbot.shared",
      OpenMausKeychainAccessGroup: "ORIGTEAM01.group.com.openmausbot.shared",
      OpenMausLegacyKeychainAccessGroup: "ORIGTEAM01.com.openmausbot.app",
      ExpoWidgets_EnablePushNotifications: false,
      UIBackgroundModes: ["audio"],
    });
    writeFileSync(join(appDir, "EXConstants.bundle", "app.config"), JSON.stringify({
      scheme: "openmausbot-dev",
      ios: { bundleIdentifier: "com.openmausbot.app.dev" },
      extra: { remotePush: { enabled: false, apnsEnvironment: "sandbox" } },
    }));
    writePlistFromObject(join(appDir, "PlugIns", "ExpoWidgetsTarget.appex", "Info.plist"), {
      CFBundleIdentifier: "com.openmausbot.app.widgets",
      ExpoWidgetsAppGroupIdentifier: "group.com.openmausbot.shared",
    });
    writePlistFromObject(join(appDir, "PlugIns", "expo-sharing-extension.appex", "Info.plist"), {
      CFBundleIdentifier: "com.openmausbot.app.share",
      AppGroupId: "group.com.openmausbot.shared",
    });

    const summary = patchExtractedAppBundle(appDir, {
      teamId: "ab12cd34ef",
      bundleId: "com.example.mausbot",
      environment: "sandbox",
      stripShareExtension: true,
    });

    expect(summary).toEqual({
      bundleId: "com.example.mausbot",
      teamId: "AB12CD34EF",
      appGroup: "group.com.example.mausbot",
      environment: "sandbox",
      widgetsBundleId: "com.example.mausbot.widgets",
      shareBundleId: null,
    });

    const mainInfo = plistToJson(join(appDir, "Info.plist"));
    expect(mainInfo.CFBundleIdentifier).toBe("com.example.mausbot");
    expect(mainInfo.OpenMausAppGroup).toBe("group.com.example.mausbot");
    expect(mainInfo.ExpoWidgetsAppGroupIdentifier).toBe("group.com.example.mausbot");
    expect(mainInfo.OpenMausKeychainAccessGroup).toBe("AB12CD34EF.group.com.example.mausbot");
    expect(mainInfo.OpenMausLegacyKeychainAccessGroup).toBe("AB12CD34EF.com.example.mausbot");
    expect(mainInfo.ExpoWidgets_EnablePushNotifications).toBe(true);
    expect(mainInfo.NSSupportsLiveActivities).toBe(true);
    expect(mainInfo.NSSupportsLiveActivitiesFrequentUpdates).toBe(true);
    expect(mainInfo.NSUserActivityTypes).toEqual(["INSendMessageIntent"]);
    expect(mainInfo.UIBackgroundModes).toEqual(["audio", "remote-notification"]);

    const appConfig = JSON.parse(readFileSync(join(appDir, "EXConstants.bundle", "app.config"), "utf8"));
    expect(appConfig.scheme).toBe("openmausbot");
    expect(appConfig.ios.bundleIdentifier).toBe("com.example.mausbot");
    expect(appConfig.ios.infoPlist.NSSupportsLiveActivities).toBe(true);
    expect(appConfig.ios.infoPlist.NSSupportsLiveActivitiesFrequentUpdates).toBe(true);
    expect(appConfig.extra.remotePush).toEqual({ enabled: true, apnsEnvironment: "sandbox" });

    const widgetsInfo = plistToJson(join(appDir, "PlugIns", "ExpoWidgetsTarget.appex", "Info.plist"));
    expect(widgetsInfo.CFBundleIdentifier).toBe("com.example.mausbot.widgets");
    expect(widgetsInfo.ExpoWidgetsAppGroupIdentifier).toBe("group.com.example.mausbot");
    expect(existsSync(join(appDir, "PlugIns", "expo-sharing-extension.appex"))).toBe(false);
    expect(existsSync(join(appDir, "OmbRuntimePatch.js"))).toBe(true);

    expect(() => patchExtractedAppBundle(appDir, {
      teamId: "AB12CD34EF",
      bundleId: "com.example.mausbot",
      environment: "development",
    })).toThrow(/Invalid --environment/);
  });

  it("validates provisioning profile aps-environment, application-identifier, and App Group entitlements", () => {
    const validMain = {
      "aps-environment": "development",
      "application-identifier": "AB12CD34EF.com.example.mausbot",
      "com.apple.security.application-groups": ["group.com.example.mausbot"],
    };
    expect(() => validateProvisionEntitlements(validMain, {
      label: "Main",
      teamId: "AB12CD34EF",
      bundleId: "com.example.mausbot",
      appGroup: "group.com.example.mausbot",
      expectedAps: "development",
    })).not.toThrow();

    expect(() => validateProvisionEntitlements({ ...validMain, "application-identifier": "AB12CD34EF.*" }, {
      label: "Widgets",
      teamId: "AB12CD34EF",
      bundleId: "com.example.mausbot.widgets",
      appGroup: "group.com.example.mausbot",
    })).not.toThrow();

    expect(() => validateProvisionEntitlements({ ...validMain, "application-identifier": "OTHERTEAM1.com.example.mausbot" }, {
      label: "Main",
      teamId: "AB12CD34EF",
      bundleId: "com.example.mausbot",
      appGroup: "group.com.example.mausbot",
      expectedAps: "development",
    })).toThrow(/application-identifier/);

    expect(() => validateProvisionEntitlements({ ...validMain, "com.apple.security.application-groups": ["group.other"] }, {
      label: "Main",
      teamId: "AB12CD34EF",
      bundleId: "com.example.mausbot",
      appGroup: "group.com.example.mausbot",
      expectedAps: "development",
    })).toThrow(/application-groups/);

    expect(() => validateProvisionEntitlements({
      ...validMain,
      "com.apple.developer.team-identifier": "OTHERTEAM1",
    }, {
      label: "Main",
      teamId: "AB12CD34EF",
      bundleId: "com.example.mausbot",
      appGroup: "group.com.example.mausbot",
      expectedAps: "development",
    })).toThrow(/team-identifier/);

    expect(() => validateProvisionEntitlements({
      ...validMain,
      "keychain-access-groups": ["OTHERTEAM1.*"],
    }, {
      label: "Main",
      teamId: "AB12CD34EF",
      bundleId: "com.example.mausbot",
      appGroup: "group.com.example.mausbot",
      expectedAps: "development",
      requireKeychainGroups: true,
    })).toThrow(/keychain-access-groups/);
  });

  it("expands concrete signing entitlements without profile wildcards so Keychain and installd succeed", () => {
    const profileEntitlements = {
      "application-identifier": "AB12CD34EF.*",
      "com.apple.developer.team-identifier": "AB12CD34EF",
      "aps-environment": "development",
      "com.apple.security.application-groups": ["group.com.example.mausbot"],
      "keychain-access-groups": ["AB12CD34EF.*"],
      "com.apple.developer.usernotifications.time-sensitive": true,
      "get-task-allow": true,
    };

    const mainSigned = buildSigningEntitlements(profileEntitlements, {
      teamId: "AB12CD34EF",
      bundleId: "com.example.mausbot",
      appGroup: "group.com.example.mausbot",
      expectedAps: "development",
      includeKeychainGroups: true,
    });
    expect(mainSigned).toEqual({
      "application-identifier": "AB12CD34EF.com.example.mausbot",
      "com.apple.developer.team-identifier": "AB12CD34EF",
      "com.apple.security.application-groups": ["group.com.example.mausbot"],
      "keychain-access-groups": [
        "AB12CD34EF.com.example.mausbot",
        "AB12CD34EF.group.com.example.mausbot",
      ],
      "aps-environment": "development",
      "com.apple.developer.usernotifications.time-sensitive": true,
      "get-task-allow": true,
    });
    expect(JSON.stringify(mainSigned)).not.toContain("*");

    const commSigned = buildSigningEntitlements({
      ...profileEntitlements,
      "com.apple.developer.usernotifications.communication": true,
    }, {
      teamId: "AB12CD34EF",
      bundleId: "com.example.mausbot",
      appGroup: "group.com.example.mausbot",
      expectedAps: "development",
      includeKeychainGroups: true,
    });
    expect(commSigned["com.apple.developer.usernotifications.communication"]).toBe(true);

    const widgetsSigned = buildSigningEntitlements(profileEntitlements, {
      teamId: "AB12CD34EF",
      bundleId: "com.example.mausbot.widgets",
      appGroup: "group.com.example.mausbot",
    });
    expect(widgetsSigned).toEqual({
      "application-identifier": "AB12CD34EF.com.example.mausbot.widgets",
      "com.apple.developer.team-identifier": "AB12CD34EF",
      "com.apple.security.application-groups": ["group.com.example.mausbot"],
      "get-task-allow": true,
    });
  });

  it("extracts Entitlements from decoded mobileprovision XML containing date and data nodes", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-ipa-profile-test-"));
    tempDirs.push(root);
    const plistPath = join(root, "decoded-profile.plist");
    writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CreationDate</key>
  <date>2026-11-23T06:10:09Z</date>
  <key>DeveloperCertificates</key>
  <array><data>MIIB</data></array>
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key>
    <string>AB12CD34EF.com.example.mausbot</string>
    <key>aps-environment</key>
    <string>development</string>
  </dict>
</dict>
</plist>`, "utf8");

    expect(extractPlistEntitlements(plistPath)).toEqual({
      "application-identifier": "AB12CD34EF.com.example.mausbot",
      "aps-environment": "development",
    });

    const missingPath = join(root, "missing-entitlements.plist");
    writePlistFromObject(missingPath, { Name: "Broken" }, "xml1");
    expect(() => extractPlistEntitlements(missingPath, "broken.mobileprovision")).toThrow(
      /No Entitlements dictionary found in provisioning profile: broken\.mobileprovision/,
    );
  });

  it("injects an idempotent LC_LOAD_WEAK_DYLIB load command into a 64-bit arm64 Mach-O binary", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-macho-inject-test-"));
    tempDirs.push(root);
    const src = join(root, "stub.c");
    const bin = join(root, "StubApp");
    writeFileSync(src, "int main(void) { return 0; }\n", "utf8");
    execFileSync("/usr/bin/clang", [
      "-arch", "arm64",
      "-Wl,-headerpad,0x400",
      src,
      "-o", bin,
    ]);

    const first = injectMachOLoadDylib(bin, "@executable_path/Frameworks/OmbNotificationAvatar.dylib");
    expect(first.injected).toBe(true);
    const second = injectMachOLoadDylib(bin, "@executable_path/Frameworks/OmbNotificationAvatar.dylib");
    expect(second).toEqual({ injected: false, reason: "already-present" });

    const otoolOut = execFileSync("/usr/bin/otool", ["-L", bin], { encoding: "utf8" });
    expect(otoolOut).toContain("@executable_path/Frameworks/OmbNotificationAvatar.dylib");
  });
});

describe("OmbRuntimePatch.js", () => {
  it("supports ExpoWidgets getId(), blocks prop-less background end(), and allows background completion end('after') with >=30s linger", async () => {
    const patchSource = readFileSync(new URL("./OmbRuntimePatch.js", import.meta.url), "utf8");
    let currentAppState = "background";
    const bridgeRequests: string[] = [];
    const endCalls: Array<{ id: string; args: unknown[] }> = [];

    class MockNativeLiveActivity {
      private activityId: string;
      private token: string | null;
      constructor(id: string, token: string | null) {
        this.activityId = id;
        this.token = token;
      }
      getId() {
        return this.activityId;
      }
      end(...args: unknown[]) {
        endCalls.push({ id: this.activityId, args });
        return Promise.resolve();
      }
      getPushToken() {
        return Promise.resolve(this.token);
      }
      addListener() {
        return { remove: () => {} };
      }
    }

    const pushStarted = new MockNativeLiveActivity("push-act-1", "AA".repeat(40));
    const instances = [pushStarted];
    const sandbox: Record<string, unknown> = {
      Date,
      Promise,
      Set,
      Map,
      Array,
      Object,
      Proxy,
      Reflect,
      String,
      JSON,
      encodeURIComponent,
      setTimeout,
      clearTimeout,
      setInterval: () => 1,
      fetch: (url: string) => {
        bridgeRequests.push(url);
        return Promise.resolve({});
      },
      __turboModuleProxy: (name: string) => (name === "AppState" ? {
        getConstants: () => ({ initialAppState: currentAppState }),
        getCurrentAppState: (ok: (res: { app_state: string }) => void) => ok({ app_state: currentAppState }),
      } : null),
      expo: {
        modules: {
          ExpoWidgets: {
            LiveActivityFactory: {
              start: () => {
                const local = new MockNativeLiveActivity("local-act-1", "BB".repeat(40));
                instances.push(local);
                return local;
              },
              getInstances: () => instances,
            },
          },
        },
      },
    };
    sandbox.globalThis = sandbox;
    sandbox.global = sandbox;

    vm.runInNewContext(patchSource, sandbox);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(bridgeRequests).toEqual([
      "https://omb-runtime-bridge.invalid/activity-wake?id=push-act-1",
      `https://omb-runtime-bridge.invalid/activity-token?id=push-act-1&token=${"aa".repeat(40)}`,
    ]);
    await pushStarted.end();
    expect(endCalls).toHaveLength(0);

    currentAppState = "active";
    const factory = ((sandbox.expo as {
      modules: {
        ExpoWidgets: {
          LiveActivityFactory: {
            start: (name: string, propsJson?: string, url?: string) => MockNativeLiveActivity;
          };
        };
      };
    }).modules.ExpoWidgets.LiveActivityFactory);
    const endPromise = pushStarted.end("immediate");
    expect(endCalls).toHaveLength(0);

    const localStarted = factory.start(
      "BotActivity",
      JSON.stringify({ botId: "bot-77", link: "openmausbot://chat/thread-not-bot" }),
      "openmausbot://chat/thread-not-bot",
    );
    await endPromise;
    expect(endCalls).toHaveLength(1);
    expect(endCalls[0]?.id).toBe("push-act-1");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridgeRequests).toContain("https://omb-runtime-bridge.invalid/activity-wake?botId=bot-77");
    expect(bridgeRequests).toContain(
      `https://omb-runtime-bridge.invalid/activity-token?id=local-act-1&botId=bot-77&token=${"bb".repeat(40)}`,
    );

    currentAppState = "background";
    await localStarted.end("immediate");
    expect(endCalls).toHaveLength(1);

    const beforeCompletionMs = Date.now();
    const donePropsJson = JSON.stringify({ kind: "done", status: "已完成" });
    await localStarted.end("after", beforeCompletionMs + 8_000, donePropsJson, beforeCompletionMs);
    expect(endCalls).toHaveLength(2);
    expect(endCalls[1]?.id).toBe("local-act-1");
    expect(endCalls[1]?.args[0]).toBe("after");
    expect(typeof endCalls[1]?.args[1]).toBe("number");
    expect((endCalls[1]?.args[1] as number) >= beforeCompletionMs + 30_000).toBe(true);
    expect(endCalls[1]?.args[2]).toBe(donePropsJson);
  });

  it("strips startToken, upgrades empty kinds after permission grant, preserves running background activity tokens, and clears ended tokens", async () => {
    const patchSource = readFileSync(new URL("./OmbRuntimePatch.js", import.meta.url), "utf8");
    const deviceRegs: Array<Record<string, unknown>> = [];
    const activityRegs: Array<Record<string, unknown>> = [];
    let permissionStatus = "undetermined";
    let currentAppState = "active";

    class MockActivity {
      private activityId: string;
      private token: string;
      constructor(id: string, token: string) {
        this.activityId = id;
        this.token = token;
      }
      getId() {
        return this.activityId;
      }
      getPushToken() {
        return Promise.resolve(this.token);
      }
      addListener() {
        return { remove: () => {} };
      }
      end() {
        return Promise.resolve();
      }
    }

    let latestInstance: MockActivity | null = null;
    const sandbox: Record<string, unknown> = {
      Date,
      Promise,
      Set,
      Map,
      Array,
      Object,
      Proxy,
      Reflect,
      String,
      JSON,
      encodeURIComponent,
      setTimeout,
      clearTimeout,
      fetch: () => Promise.resolve({}),
      __turboModuleProxy: (name: string) => (name === "AppState" ? {
        getConstants: () => ({ initialAppState: currentAppState }),
        getCurrentAppState: (ok: (res: { app_state: string }) => void) => ok({ app_state: currentAppState }),
      } : null),
      expo: {
        modules: {
          ExpoNotificationPermissionsModule: {
            getPermissionsAsync: () => Promise.resolve({ status: permissionStatus, granted: permissionStatus === "granted", canAskAgain: true }),
            requestPermissionsAsync: () => {
              permissionStatus = "granted";
              return Promise.resolve({ status: "granted", granted: true });
            },
          },
          ExpoWidgets: {
            LiveActivityFactory: {
              start: () => {
                latestInstance = new MockActivity("act-99", "cc".repeat(40));
                return latestInstance;
              },
              getInstances: () => (latestInstance ? [latestInstance] : []),
            },
          },
        },
      },
    };
    sandbox.globalThis = sandbox;
    sandbox.global = sandbox;
    vm.runInNewContext(patchSource, sandbox);
    expect("__d" in sandbox).toBe(false);

    const factories = new Map<number, (g: unknown, r: (id: number) => unknown, i: unknown, a: unknown, m: { exports: Record<string, unknown> }, e: Record<string, unknown>) => void>();
    const cache = new Map<number, { exports: Record<string, unknown> }>();
    const req = (id: number) => {
      const existing = cache.get(id);
      if (existing) return existing.exports;
      const mod = { exports: {} as Record<string, unknown> };
      cache.set(id, mod);
      factories.get(id)!(sandbox, req, null, null, mod, mod.exports);
      return mod.exports;
    };
    sandbox.__r = req;
    sandbox.__d = (factory: (g: unknown, r: (id: number) => unknown, i: unknown, a: unknown, m: { exports: Record<string, unknown> }, e: Record<string, unknown>) => void, id: number) => {
      factories.set(id, factory);
    };

    (sandbox.__d as (fn: (g: unknown, r: unknown, i: unknown, a: unknown, m: unknown, e: Record<string, unknown>) => void, id: number) => void)((_g, _r, _i, _a, _m, e) => {
      e.registerPushDevice = (_client: unknown, reg: Record<string, unknown>) => {
        deviceRegs.push(reg);
        return Promise.resolve("saved");
      };
      e.registerActivity = (_client: unknown, reg: Record<string, unknown>) => {
        activityRegs.push(reg);
        return Promise.resolve("saved");
      };
    }, 100);

    const pushMod = req(100) as {
      registerPushDevice: (c: unknown, r: Record<string, unknown>) => Promise<string>;
      registerActivity: (c: unknown, r: Record<string, unknown>) => Promise<string>;
    };
    const fakeClient = { id: "companion-client" };
    await pushMod.registerPushDevice(fakeClient, { platform: "apns", token: "dd".repeat(32), kinds: [] });
    await pushMod.registerActivity(fakeClient, { scheme: "openmausbot", startToken: "ee".repeat(40), kinds: [], activities: [] });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(deviceRegs.at(-1)?.kinds).toEqual(["approval", "question", "sign-in", "done"]);
    expect(activityRegs.at(-1)?.kinds).toEqual(["needsYou", "working"]);
    for (const reg of activityRegs) {
      expect("startToken" in reg).toBe(false);
    }

    const factory = (sandbox.expo as { modules: { ExpoWidgets: { LiveActivityFactory: { start: (n: string, p: string, u: string) => MockActivity } } } }).modules.ExpoWidgets.LiveActivityFactory;
    const started = factory.start(
      "BotActivity",
      JSON.stringify({ botId: "bot-abc", link: "openmausbot://chat/thread-xyz" }),
      "openmausbot://chat/thread-xyz",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(activityRegs.at(-1)).toMatchObject({
      kinds: ["needsYou", "working"],
      activities: [{ botId: "bot-abc", token: "cc".repeat(40) }],
    });
    expect("startToken" in (activityRegs.at(-1) ?? {})).toBe(false);

    currentAppState = "background";
    (sandbox.__ombLiveActivityGuard as { appState: string }).appState = "background";
    await pushMod.registerActivity(fakeClient, { scheme: "openmausbot", startToken: "ee".repeat(40), kinds: ["needsYou", "working"], activities: [] });
    expect(activityRegs.at(-1)).toMatchObject({
      activities: [{ botId: "bot-abc", token: "cc".repeat(40) }],
    });
    expect("startToken" in (activityRegs.at(-1) ?? {})).toBe(false);

    await (started as unknown as { end: (...args: unknown[]) => Promise<void> }).end("after", Date.now() + 8_000, JSON.stringify({ kind: "done" }), Date.now());
    await pushMod.registerActivity(fakeClient, { scheme: "openmausbot", startToken: "ee".repeat(40), kinds: ["needsYou", "working"], activities: [] });
    expect(activityRegs.at(-1)?.activities).toEqual([]);
    expect("startToken" in (activityRegs.at(-1) ?? {})).toBe(false);
  });

  it("patches Metro ScreenRow across nested ROW_KINDS.{hidden,full} and function media.access() while invoking origScreenRow once per render", () => {
    const patchSource = readFileSync(new URL("./OmbRuntimePatch.js", import.meta.url), "utf8");

    type MockElement = {
      $$typeof: symbol;
      type: string;
      props: Record<string, unknown>;
    };
    const ELEMENT_SYMBOL = Symbol.for("mock.react.element");

    function buildReactMock() {
      let stateSlot: unknown;
      let stateInitialized = false;
      return {
        resetState() {
          stateSlot = undefined;
          stateInitialized = false;
        },
        api: {
          useState<T>(initial: T): [T, (next: T) => void] {
            if (!stateInitialized) {
              stateSlot = initial;
              stateInitialized = true;
            }
            return [
              stateSlot as T,
              (next: T) => {
                stateSlot = next;
              },
            ];
          },
          createElement(type: string, props?: Record<string, unknown> | null, ...children: unknown[]): MockElement {
            const nextProps: Record<string, unknown> = { ...props };
            if (children.length === 1) nextProps.children = children[0];
            else if (children.length > 1) nextProps.children = children;
            return { $$typeof: ELEMENT_SYMBOL, type, props: nextProps };
          },
          isValidElement(val: unknown): val is MockElement {
            return Boolean(val && typeof val === "object" && (val as MockElement).$$typeof === ELEMENT_SYMBOL);
          },
          cloneElement(el: MockElement, nextProps?: Record<string, unknown> | null, ...children: unknown[]): MockElement {
            const merged: Record<string, unknown> = { ...el.props, ...nextProps };
            if (children.length === 1) merged.children = children[0];
            else if (children.length > 1) merged.children = children;
            return { $$typeof: ELEMENT_SYMBOL, type: el.type, props: merged };
          },
        },
      };
    }

    const reactMock = buildReactMock();
    let currentAccess: { baseUrl: string; token: string } | null = { baseUrl: "http://127.0.0.1:8799", token: "tok-1" };
    let origScreenRowCallCount = 0;
    const preBundleSandbox: Record<string, unknown> = {
      Date,
      Promise,
      Set,
      Map,
      Array,
      Object,
      Proxy,
      Reflect,
      String,
      encodeURIComponent,
    };
    preBundleSandbox.globalThis = preBundleSandbox;
    preBundleSandbox.global = preBundleSandbox;
    vm.runInNewContext(patchSource, preBundleSandbox);
    expect("__d" in preBundleSandbox).toBe(false);

    const factories = new Map<number, (g: unknown, r: (id: number) => unknown, i: unknown, a: unknown, m: { exports: Record<string, unknown> }, e: Record<string, unknown>) => void>();
    const cache = new Map<number, { exports: Record<string, unknown> }>();
    const defineFn = (factory: (g: unknown, r: (id: number) => unknown, i: unknown, a: unknown, m: { exports: Record<string, unknown> }, e: Record<string, unknown>) => void, id: number) => {
      factories.set(id, factory);
    };
    const requireFn = (id: number) => {
      const existing = cache.get(id);
      if (existing) return existing.exports;
      const factory = factories.get(id);
      if (!factory) throw new Error(`Unknown module ${id}`);
      const mod = { exports: {} as Record<string, unknown> };
      cache.set(id, mod);
      factory(preBundleSandbox, requireFn, null, null, mod, mod.exports);
      return mod.exports;
    };
    preBundleSandbox.__r = requireFn;
    preBundleSandbox.__d = defineFn;

    const d = preBundleSandbox.__d as typeof defineFn;
    d((_g, _r, _i, _a, m) => {
      m.exports = reactMock.api;
    }, 10);
    d((_g, _r, _i, _a, m) => {
      m.exports = {
        useAttachmentMedia: () => ({
          access: () => currentAccess,
          subscribe: () => () => {},
          revision: () => 1,
        }),
        useMediaRevision: (media: { subscribe: () => () => void; revision: () => number }) => {
          if (!media || typeof media.subscribe !== "function" || typeof media.revision !== "function") {
            throw new TypeError("Cannot read property 'subscribe' of undefined");
          }
          return media.revision();
        },
        screenSource: (access: { baseUrl?: string; token?: string } | null, threadId: string, messageId: string) =>
          access && typeof access.baseUrl === "string" && typeof access.token === "string"
            ? {
                uri: `${access.baseUrl}/api/threads/${threadId}/messages/${messageId}/image`,
                headers: { Authorization: `Bearer ${access.token}` },
                cacheKey: `${access.token}:screen:${threadId}:${messageId}`,
              }
            : null,
      };
    }, 20);
    d((_g, _r, _i, _a, _m, e) => {
      e.DigestRow = () => null;
      e.ScreenRow = ({ message }: { message: { png?: string; mime?: string; label?: string } }) => {
        origScreenRowCallCount += 1;
        if (!message.png) {
          return reactMock.api.createElement("View", { className: "card" }, reactMock.api.createElement("Text", null, "無法使用螢幕截圖"));
        }
        const mime = message.mime || "image/png";
        return reactMock.api.createElement(
          "View",
          { className: "card" },
          reactMock.api.createElement("ExpoImage", {
            source: { uri: `data:${mime};base64,${message.png}` },
            accessibilityLabel: message.label || "Screenshot",
          }),
        );
      };
    }, 30);
    d((_g, r, _i, _a, _m, e) => {
      const cards = r(30) as { ScreenRow: (props: unknown) => MockElement };
      const byMode = {
        hidden: { screen: { Row: cards.ScreenRow } },
        full: { screen: { Row: cards.ScreenRow } },
      };
      e.ROW_KINDS = byMode;
      e.rowKindsFor = (mode: "hidden" | "full") => byMode[mode];
    }, 40);

    const r = preBundleSandbox.__r as typeof requireFn;
    r(10);
    r(20);
    const rowKinds = r(40) as {
      ROW_KINDS: {
        hidden: { screen: { Row: (props: unknown) => MockElement } };
        full: { screen: { Row: (props: unknown) => MockElement } };
      };
      rowKindsFor: (mode: "hidden" | "full") => { screen: { Row: (props: unknown) => MockElement } };
    };

    reactMock.resetState();
    origScreenRowCallCount = 0;
    const renderedRemote = rowKinds.ROW_KINDS.full.screen.Row({
      message: { id: "msg-8edf", kind: "screen", mime: "image/jpeg", hasImage: true, label: "Attendance" },
      context: { threadId: "thread-abc" },
    });
    expect(origScreenRowCallCount).toBe(1);
    const remoteImg = renderedRemote.props.children as MockElement;
    expect(remoteImg.type).toBe("ExpoImage");
    expect(remoteImg.props.accessibilityLabel).toBe("Attendance");
    expect(remoteImg.props.source).toEqual({
      uri: "http://127.0.0.1:8799/api/threads/thread-abc/messages/msg-8edf/image",
      headers: { Authorization: "Bearer tok-1" },
      cacheKey: "tok-1:screen:thread-abc:msg-8edf",
    });

    (remoteImg.props.onError as () => void)();
    origScreenRowCallCount = 0;
    const afterError = rowKinds.ROW_KINDS.hidden.screen.Row({
      message: { id: "msg-8edf", kind: "screen", mime: "image/jpeg", hasImage: true },
      context: { threadId: "thread-abc" },
    });
    expect(origScreenRowCallCount).toBe(1);
    expect((afterError.props.children as MockElement).type).toBe("Text");

    currentAccess = { baseUrl: "http://127.0.0.1:8799", token: "tok-2" };
    const afterReconnect = rowKinds.rowKindsFor("hidden").screen.Row({
      message: { id: "msg-8edf", kind: "screen", mime: "image/jpeg", hasImage: true },
      context: { threadId: "thread-abc" },
    });
    expect((afterReconnect.props.children as MockElement).type).toBe("ExpoImage");

    reactMock.resetState();
    const inlineRendered = rowKinds.ROW_KINDS.hidden.screen.Row({
      message: { id: "msg-inline", kind: "screen", mime: "image/jpeg", png: "/9j/4AAQ", hasImage: true },
      context: { threadId: "thread-abc" },
    });
    expect(((inlineRendered.props.children as MockElement).props.source as { uri: string }).uri).toBe("data:image/jpeg;base64,/9j/4AAQ");

    const postReact = buildReactMock();
    let guardedCalledForMissing = false;
    const postModules = new Map<number, Record<string, unknown>>([
      [54, postReact.api as unknown as Record<string, unknown>],
      [
        2211,
        {
          useAttachmentMedia: () => ({
            access: () => ({ baseUrl: "http://127.0.0.1:9999", token: "post-tok" }),
            subscribe: () => () => {},
            revision: () => 0,
          }),
          useMediaRevision: (media: { subscribe: () => () => void; revision: () => number }) => {
            if (!media || typeof media.subscribe !== "function") {
              throw new TypeError("Cannot read property 'subscribe' of undefined");
            }
            return media.revision();
          },
          screenSource: (access: { baseUrl?: string; token?: string } | null, tid: string, mid: string) =>
            access && typeof access.baseUrl === "string"
              ? {
                  uri: `${access.baseUrl}/api/threads/${tid}/messages/${mid}/image`,
                  cacheKey: `post:${tid}:${mid}`,
                }
              : null,
        },
      ],
    ]);
    const origPostScreenRow = ({ message }: { message: { png?: string } }) =>
      message.png
        ? postReact.api.createElement("View", null, postReact.api.createElement("ExpoImage", { source: { uri: `data:image/png;base64,${message.png}` } }))
        : postReact.api.createElement("View", null, reactMock.api.createElement("Text", null, "unavailable"));
    postModules.set(2376, { DigestRow: () => null, ScreenRow: origPostScreenRow });
    const postHidden = { screen: { Row: origPostScreenRow } };
    const postFull = { screen: { Row: origPostScreenRow } };
    postModules.set(2366, {
      ROW_KINDS: { hidden: postHidden, full: postFull },
      rowKindsFor: (mode: "hidden" | "full") => (mode === "full" ? postFull : postHidden),
    });

    const postRequire = Object.assign(
      (id: number) => {
        if (!postModules.has(id)) {
          guardedCalledForMissing = true;
          throw new Error(`Guarded missing ${id}`);
        }
        return postModules.get(id);
      },
      {
        unguarded: (id: number) => {
          const hit = postModules.get(id);
          if (!hit) throw new Error(`Unguarded missing ${id}`);
          return hit;
        },
      },
    );
    const postSandbox: Record<string, unknown> = {
      Date,
      Promise,
      Set,
      Map,
      Array,
      Object,
      Proxy,
      Reflect,
      String,
      encodeURIComponent,
      __d: () => {},
      __r: postRequire,
    };
    postSandbox.globalThis = postSandbox;
    postSandbox.global = postSandbox;
    vm.runInNewContext(patchSource, postSandbox);

    expect(guardedCalledForMissing).toBe(false);
    expect(postFull.screen.Row).not.toBe(origPostScreenRow);
    expect(postHidden.screen.Row).not.toBe(origPostScreenRow);
    const postResult = postFull.screen.Row({
      message: { id: "m2", kind: "screen", hasImage: true },
      context: { threadId: "t2" },
    });
    expect(((postResult.props.children as MockElement).props.source as { uri: string }).uri).toBe(
      "http://127.0.0.1:9999/api/threads/t2/messages/m2/image"
    );
  });

  it("patches constructor-based LiveActivityFactory and wraps synchronous getPushToken after pre-bundle bootstrap", async () => {
    const patchSource = readFileSync(join(import.meta.dirname, "OmbRuntimePatch.js"), "utf8");
    let nativeAppState = "active";
    const bridgeCalls: Array<{ action: string; payload: string }> = [];

    const sandbox: Record<string, unknown> = {
      Date,
      Promise,
      Set,
      Map,
      Array,
      Object,
      Proxy,
      Reflect,
      String,
      JSON,
      encodeURIComponent,
      __ombNativeBridge: (action: string, payload: string) => {
        if (action === "/app-state") return nativeAppState;
        bridgeCalls.push({ action, payload });
        return true;
      },
    };
    sandbox.globalThis = sandbox;
    sandbox.global = sandbox;

    vm.runInNewContext(patchSource, sandbox);
    expect("__d" in sandbox).toBe(false);

    let tokenListener: ((ev: { activityId: string; pushToken: string }) => void) | null = null;
    let endedCount = 0;

    class NativeLiveActivity {
      getId() {
        return "act-ctor-1";
      }
      getPushToken(): string | null {
        return null;
      }
      addListener(event: string, cb: (ev: { activityId: string; pushToken: string }) => void) {
        if (event === "onExpoWidgetsTokenReceived") tokenListener = cb;
        return { remove: () => {} };
      }
      async end() {
        endedCount += 1;
      }
    }

    const liveInstances: NativeLiveActivity[] = [];
    class NativeLiveActivityFactory {
      name: string;
      layout: string;
      constructor(name: string, layout: string) {
        this.name = name;
        this.layout = layout;
      }
      start(_props?: string) {
        const inst = new NativeLiveActivity();
        liveInstances.push(inst);
        return inst;
      }
      getInstances() {
        return liveInstances;
      }
    }

    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;
    sandbox.setInterval = () => 1;
    sandbox.expo = {
      modules: {
        ExpoWidgets: {
          LiveActivity: NativeLiveActivity,
          LiveActivityFactory: NativeLiveActivityFactory,
        },
      },
    };

    const definedModules = new Map<number, (g: unknown, r: (id: number) => unknown, i: unknown, a: unknown, m: { exports: Record<string, unknown> }, e: Record<string, unknown>) => void>();
    const evaluated = new Map<number, Record<string, unknown>>();
    sandbox.__d = (factory: (g: unknown, r: (id: number) => unknown, i: unknown, a: unknown, m: { exports: Record<string, unknown> }, e: Record<string, unknown>) => void, id: number) => {
      definedModules.set(id, factory);
    };
    const metroRequire = Object.assign(
      (id: number) => {
        if (evaluated.has(id)) return evaluated.get(id);
        const factory = definedModules.get(id);
        if (!factory) throw new Error(`Missing module ${id}`);
        const mod = { exports: {} as Record<string, unknown> };
        factory(sandbox, metroRequire, null, null, mod, mod.exports);
        evaluated.set(id, mod.exports);
        return mod.exports;
      },
      {
        unguarded: (id: number) => {
          if (!definedModules.has(id)) throw new Error(`Missing ${id}`);
          return metroRequire(id);
        },
      },
    );
    sandbox.__r = metroRequire;

    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));

    const expoWidgets = (sandbox.expo as { modules: { ExpoWidgets: { LiveActivityFactory: typeof NativeLiveActivityFactory } } }).modules.ExpoWidgets;
    const factory = new expoWidgets.LiveActivityFactory("BotActivity", "function(){}");
    const started = factory.start(JSON.stringify({ botId: "bot-42", kind: "working" }));

    // main.jsbundle calls `started.getPushToken().catch(() => null)` expecting a Promise even though ExpoWidgets 58.0.29 is sync.
    const initialToken = await (started.getPushToken() as unknown as Promise<string | null>).catch(() => "threw");
    expect(initialToken).toBeNull();

    expect(tokenListener).not.toBeNull();
    const validHex = "ab".repeat(32);
    tokenListener!({ activityId: "act-ctor-1", pushToken: validHex });

    const tokenBridge = bridgeCalls.find((c) => c.action === "/activity-token");
    expect(tokenBridge).toBeDefined();
    expect(JSON.parse(tokenBridge!.payload)).toEqual({
      id: "act-ctor-1",
      botId: "bot-42",
      token: validHex,
    });

    nativeAppState = "background";
    await started.end();
    expect(endedCount).toBe(0);

    await (started as unknown as { end: (policy: string, afterMs: number, props: string) => Promise<void> }).end(
      "after",
      Date.now() + 5000,
      JSON.stringify({ kind: "done" }),
    );
    expect(endedCount).toBe(1);
  });
});
