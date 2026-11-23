// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { SettingsLook } from "./SettingsPrimitives";
import { IosPushSettingsSection } from "./IosPushSettingsSection";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  dispatch: vi.fn(),
  config: {
    apns: {
      enabled: true,
      includePreview: true,
      configured: false,
      teamId: "",
      keyId: "",
      bundleId: "",
      environment: "sandbox" as "sandbox" | "production",
      hasPrivateKey: false,
      apnsDevices: 0,
      activityTokens: 0,
    },
  },
}));

vi.mock("@/state/store", () => ({ api: fixture.api }));
vi.mock("@/state/store-select", () => ({
  sameFields: () => false,
  useStoreSelector: (sel: (s: unknown) => unknown) => sel({ config: fixture.config }),
  useStoreDispatch: () => fixture.dispatch,
}));

let host: HTMLDivElement;
let root: Root;

function setInput(testId: string, value: string) {
  const el = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testId}"]`)!;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  flushSync(() => el.dispatchEvent(new Event("input", { bubbles: true })));
}

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  fixture.config = {
    apns: {
      enabled: true,
      includePreview: true,
      configured: false,
      teamId: "",
      keyId: "",
      bundleId: "",
      environment: "sandbox",
      hasPrivateKey: false,
      apnsDevices: 0,
      activityTokens: 0,
    },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("IosPushSettingsSection", () => {
  it("saves APNs credentials via PUT /api/push/apns and sends test notifications via POST /api/push/apns/test", async () => {
    flushSync(() => root.render(createElement(SettingsLook.Provider, { value: true }, createElement(IosPushSettingsSection))));
    const foldButton = host.querySelector<HTMLButtonElement>('[data-settings-disclosure="ios-apns"] button')!;
    flushSync(() => foldButton.click());

    setInput("apns-team-id", "team123456");
    setInput("apns-key-id", "key1234567");
    setInput("apns-bundle-id", "com.example.mausbot");
    setInput("apns-private-key", "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----");

    fixture.api.mockResolvedValueOnce({
      apns: {
        enabled: true,
        includePreview: true,
        configured: true,
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        bundleId: "com.example.mausbot",
        environment: "sandbox",
        hasPrivateKey: true,
        apnsDevices: 1,
        activityTokens: 1,
      },
    });

    const saveBtn = host.querySelector<HTMLButtonElement>('[data-testid="apns-save"]')!;
    expect(saveBtn.disabled).toBe(false);
    flushSync(() => saveBtn.click());

    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledTimes(1));
    expect(fixture.api).toHaveBeenCalledWith("/api/push/apns", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        includePreview: true,
        environment: "sandbox",
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        bundleId: "com.example.mausbot",
        privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
      }),
    });
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "configStatus" }));

    fixture.config = {
      apns: {
        enabled: true,
        includePreview: true,
        configured: true,
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        bundleId: "com.example.mausbot",
        environment: "sandbox",
        hasPrivateKey: true,
        apnsDevices: 1,
        activityTokens: 1,
      },
    };
    flushSync(() => root.render(createElement(SettingsLook.Provider, { value: true }, createElement(IosPushSettingsSection))));

    fixture.api.mockResolvedValueOnce({ ok: true, sent: 1, total: 1 });
    const testBtn = host.querySelector<HTMLButtonElement>('[data-testid="apns-test"]')!;
    expect(testBtn.disabled).toBe(false);
    flushSync(() => testBtn.click());

    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/push/apns/test", { method: "POST", body: "{}" }));
    await vi.waitFor(() => expect(host.textContent).toContain("Sent test notification to 1 of 1 iPhone devices."));

    const previewSwitch = host.querySelector<HTMLButtonElement>('[aria-label="Show message previews"]')!;
    expect(previewSwitch.getAttribute("aria-checked")).toBe("true");
    flushSync(() => previewSwitch.click());
    expect(previewSwitch.getAttribute("aria-checked")).toBe("false");

    fixture.api.mockResolvedValueOnce({
      apns: {
        ...fixture.config.apns,
        includePreview: false,
      },
    });
    const saveAfterToggle = host.querySelector<HTMLButtonElement>('[data-testid="apns-save"]')!;
    expect(saveAfterToggle.disabled).toBe(false);
    flushSync(() => saveAfterToggle.click());
    await vi.waitFor(() => expect(fixture.api).toHaveBeenLastCalledWith("/api/push/apns", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        includePreview: false,
        environment: "sandbox",
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        bundleId: "com.example.mausbot",
      }),
    }));
  });
});
