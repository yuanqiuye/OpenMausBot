# This fork and OpenMausBot's hosted services

This fork (yuanqiuye/OpenMausBot) offers none of OpenMausBot's hosted services. One switch,
`OPENMAUSBOT_HOSTED` in [`electron/hosted-services.mjs`](../electron/hosted-services.mjs), is `false`. The
desktop app, its server and its pages read it, and
[`electron/hosted-services.node-test.mjs`](../electron/hosted-services.node-test.mjs) holds it there.

| Service | Upstream | Here |
| --- | --- | --- |
| MausBot Cloud (My Cloud, Team Cloud, plans, Add a Cloud, Move to Cloud, places together) | `cloud.openmausbot.com` | No Cloud bridges on the page, no Cloud sign-in or restore at launch, no Add a Cloud in menus, onboarding, Devices or announcements |
| MausBot account (phone "Anywhere" relay, HTTPS address, push relay for Android, `openmausbot login`, server email sign-in through the control plane) | `accounts.openmausbot.com`, `relay*.openmausbot.com` | No default control plane. Phones pair over Wi-Fi or Tailscale. iOS alerts use direct APNs (Settings → Devices). Server email sign-in uses `OMB_SIGNIN_SMTP_URL` |
| Organization sign-in | `admin.openmausbot.com` | No menu item, deep link or bridge |
| Connected-apps broker | upstream's Composio Worker | No shipped default. Use your own Composio key, or `OMB_COMPOSIO_BROKER_URL` |
| `@devs` bug reports | `cloud.openmausbot.com/api/bug-reports` | `@devs` is an ordinary mention unless `OMB_BUG_REPORT_URL` is set |
| Announcements and release notes | upstream's `main` | This fork's `main`. Cards that open My Cloud are dropped |
| Usage analytics | upstream's PostHog project (`us.i.posthog.com`) | Nothing is sent, from the pages or at launch, and `posthog-js` is never loaded. Settings has no Usage analytics switch |

Explicit overrides still work, for your own deployments and for tests: `OMB_CONTROL_PLANE_URL`,
`OMB_COMPOSIO_BROKER_URL` and `OMB_BUG_REPORT_URL`.

The server code that runs only on a hosted Cloud machine (`server/cloud-*`, `server/host/cloud-*`) and upstream's
hosting infrastructure (`cloudflare/`, `relay/`) are left in place, unused. That keeps upstream merges small.

## Merging upstream

1. `git fetch upstream && git merge upstream/main`.
2. Look through the merge for new hosted entry points: a new `window.ogb` bridge gated on `--omb-company-desktop=1`,
   a new `openCloudAdd` dispatch, a new default `https://*.openmausbot.com` or PostHog origin, an analytics send that
   bypasses `src/lib/analytics.ts`, or a new preload argument in `electron/main.mjs`. Put each one behind
   `OPENMAUSBOT_HOSTED`.
3. Keep phone push free of a per-phone cap or throttle: in `server/phone-push.ts` a `429` from APNs is retried like a
   network failure, and only the 10-second coalescing of one kind in one conversation stays.
4. `pnpm typecheck && pnpm lint && pnpm test:electron && pnpm vitest run`.
