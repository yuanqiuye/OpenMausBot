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

  it("guards background LiveActivity.end() calls and relays push-started tokens in OmbRuntimePatch.js", async () => {
    const patchSource = readFileSync(new URL("./OmbRuntimePatch.js", import.meta.url), "utf8");
    let currentAppState = "background";
    const bridgeRequests: string[] = [];
    let endedCount = 0;

    class MockNativeLiveActivity {
      id: string;
      private token: string | null;
      constructor(id: string, token: string | null) {
        this.id = id;
        this.token = token;
      }
      end() {
        endedCount += 1;
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

    // Push-started instance reports wake + hex token, while background end("immediate") is blocked.
    expect(bridgeRequests).toEqual([
      "https://omb-runtime-bridge.invalid/activity-wake?id=push-act-1",
      `https://omb-runtime-bridge.invalid/activity-token?id=push-act-1&token=${"aa".repeat(40)}`,
    ]);
    await pushStarted.end();
    expect(endedCount).toBe(0);

    // Entering foreground and starting a local replacement flushes deferred immediate end cleanly.
    currentAppState = "active";
    const factory = ((sandbox.expo as { modules: { ExpoWidgets: { LiveActivityFactory: { start: () => MockNativeLiveActivity } } } }).modules.ExpoWidgets.LiveActivityFactory);
    const endPromise = (pushStarted as { end: (policy?: string) => Promise<void> }).end("immediate");
    expect(endedCount).toBe(0);
    const localStarted = factory.start();
    await endPromise;
    expect(endedCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridgeRequests.some((url) => url.includes("local-act-1"))).toBe(false);

    // Foreground default end after initial transition window executes immediately.
    (sandbox.__ombLiveActivityGuard as { activeSinceMs: number }).activeSinceMs = Date.now() - 5_000;
    await (localStarted as { end: (policy?: string) => Promise<void> }).end("default");
    expect(endedCount).toBe(2);
  });
});
