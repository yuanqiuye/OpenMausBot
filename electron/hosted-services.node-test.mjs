import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { DEFAULT_COMPANION_CONTROL_PLANE_URL, resolveCompanionControlPlaneURL } from "./companion-account-service.mjs";
import { companyDesktopArguments, HOSTED_SERVICES_ARG, OPENMAUSBOT_HOSTED } from "./hosted-services.mjs";
import { createLaunchAnalytics } from "./launch-analytics.mjs";
import { managedComposioBrokerUrl } from "./managed-composio.mjs";

const ORIGIN = "http://127.0.0.1:48993";
const HOSTED_BRIDGES = ["cloudAccount", "cloudSendPage", "placesTogether", "accounts", "accountSheet", "cloudPlan", "organization"];

function preloadBridge(argv) {
  let bridge;
  const context = vm.createContext({
    process: { platform: "fixture", argv: [`--omb-local-origin=${ORIGIN}`, ...argv] },
    location: { origin: ORIGIN }, TextEncoder, localStorage: { getItem: () => null }, navigator: {},
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_key, value) => { bridge = value; } },
      ipcRenderer: { on: () => {}, removeListener: () => {}, send: () => {}, invoke: () => Promise.resolve(null) } }),
  });
  vm.runInContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), context);
  return bridge;
}

test("this fork offers none of OpenMausBot's hosted services", () => {
  assert.equal(OPENMAUSBOT_HOSTED, false);
});

test("the company desktop's page gets no Cloud, account, plan or organization bridge without the hosted flag", () => {
  const plain = preloadBridge(["--omb-company-desktop=1"]);
  for (const key of HOSTED_BRIDGES) assert.equal(plain[key], undefined, key);
  assert.ok(plain.companyBackups, "company backups stay");
  const hosted = preloadBridge(["--omb-company-desktop=1", HOSTED_SERVICES_ARG]);
  for (const key of HOSTED_BRIDGES) assert.ok(hosted[key], key);
});

test("main asks the preload for the hosted bridges only through the switch", () => {
  assert.deepEqual(companyDesktopArguments(false), []);
  assert.deepEqual(companyDesktopArguments(true), ["--omb-company-desktop=1"]);
  assert.deepEqual(companyDesktopArguments(true, true), ["--omb-company-desktop=1", HOSTED_SERVICES_ARG]);
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(main.split("...companyDesktopArgs(app.isPackaged && !desktopRemoteAccess)").length - 1, 3);
  assert.equal(main.includes('"--omb-company-desktop=1"') || main.includes('"--omb-hosted-services=1"'), false);
  assert.match(main, /function cloudOffersAllowed\(\) \{\n {2}return OPENMAUSBOT_HOSTED && /);
  assert.match(main, /if \(!OPENMAUSBOT_HOSTED \|\| !app\.isPackaged \|\| desktopRemoteAccess\) throw new Error\(OPENMAUSBOT_HOSTED \? /);
  assert.match(main, /if \(OPENMAUSBOT_HOSTED && app\.isPackaged && !desktopRemoteAccess\) \{\n {4}cloudAccountRestoring = true;/);
});

test("a packaged app has no MausBot account, phone relay or push relay address, nor the shared connected-apps broker", () => {
  assert.equal(DEFAULT_COMPANION_CONTROL_PLANE_URL, "");
  assert.equal(resolveCompanionControlPlaneURL({ isPackaged: true, environment: {} }), "");
  assert.equal(resolveCompanionControlPlaneURL({ isPackaged: true, environment: { OMB_CONTROL_PLANE_URL: "https://plane.example" } }), "https://plane.example");
  assert.equal(managedComposioBrokerUrl(undefined, true), "");
  assert.equal(managedComposioBrokerUrl("https://broker.example", true), "https://broker.example");
});

test("a packaged app sends no launch analytics, even with usage analytics switched on", () => {
  const sent = [];
  const analytics = createLaunchAnalytics({ fetch: async (url) => { sent.push(url); return { ok: true }; }, choice: () => true, lastVersion: null, version: "1.0.0", platform: "darwin", packaged: true, env: {} });
  for (const stage of ["started", "server_spawned", "server_ready", "window_shown"]) analytics.stage(stage);
  assert.deepEqual(sent, []);
});
