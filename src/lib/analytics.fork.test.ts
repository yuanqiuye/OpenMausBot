import { expect, it, vi } from "vitest";
import { SETTINGS_INDEX } from "@/components/settings/settings-index";
import { SETTINGS_PLACES } from "../../shared/settings-places.ts";
import { analyticsEnabled, initAnalytics, setAnalyticsEnabled, track } from "./analytics";

const ph = vi.hoisted(() => ({ loads: 0 }));
vi.mock("posthog-js", () => {
  ph.loads += 1;
  return { default: {} };
});

it("never loads PostHog or sends usage analytics, even after someone switches it on", async () => {
  setAnalyticsEnabled(true);
  await initAnalytics();
  track("app_opened");
  expect(analyticsEnabled()).toBe(false);
  expect(ph.loads).toBe(0);
});

it("leaves Usage analytics out of Settings, its search and the places bots cite", () => {
  expect(SETTINGS_INDEX.map((entry) => entry.id)).not.toContain("analytics");
  expect(SETTINGS_PLACES.flatMap((place) => [place.id, ...place.words])).not.toContain("analytics");
});
