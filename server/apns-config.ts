import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

export type ApnsEnvironment = "production" | "sandbox";

export const APNS_KEY_OR_TEAM_ID = /^[A-Z0-9]{10}$/;
export const APNS_BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** Direct APNs settings in `config.json` (`apns`), overridden by `OMB_APNS_*` environment variables. */
export const apnsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  includePreview: z.boolean().optional(),
  teamId: z.string().trim().max(32).optional(),
  keyId: z.string().trim().max(32).optional(),
  bundleId: z.string().trim().max(155).optional(),
  privateKey: z.string().max(16_384).optional(),
  environment: z.enum(["production", "sandbox"]).optional(),
});

export interface ApnsConfig {
  enabled?: boolean;
  includePreview?: boolean;
  teamId?: string;
  keyId?: string;
  bundleId?: string;
  privateKey?: string;
  environment?: ApnsEnvironment;
}

export interface ResolvedApnsConfig {
  teamId: string;
  keyId: string;
  bundleId: string;
  privateKey: string;
  defaultEnvironment: ApnsEnvironment;
  includePreview: boolean;
}

export function normalizeApnsPem(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\\n/g, "\n").trim();
}

export function validateApnsPrivateKey(raw: string): { ok: true; pem: string } | { ok: false; error: string } {
  const normalized = normalizeApnsPem(raw);
  if (!normalized.includes("-----BEGIN PRIVATE KEY-----") || !normalized.includes("-----END PRIVATE KEY-----")) {
    return { ok: false, error: "Paste a PKCS#8 .p8 private key starting with -----BEGIN PRIVATE KEY-----." };
  }
  try {
    const keyObject = createPrivateKey({ key: normalized, format: "pem" });
    if (keyObject.asymmetricKeyType !== "ec" || keyObject.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      return { ok: false, error: "The .p8 key must be an Apple P-256 ECDSA signing key." };
    }
    const exported = String(keyObject.export({ type: "pkcs8", format: "pem" })).trim();
    return { ok: true, pem: exported };
  } catch {
    return { ok: false, error: "Could not parse the .p8 private key." };
  }
}

export function validateApnsFields(input: {
  teamId?: string;
  keyId?: string;
  bundleId?: string;
  privateKey?: string;
}): { ok: true; normalized: Partial<ApnsConfig> } | { ok: false; error: string } {
  const normalized: Partial<ApnsConfig> = {};
  if (input.teamId !== undefined) {
    const teamId = input.teamId.trim().toUpperCase();
    if (teamId && !APNS_KEY_OR_TEAM_ID.test(teamId)) {
      return { ok: false, error: "Team ID must be 10 uppercase letters or digits." };
    }
    normalized.teamId = teamId;
  }
  if (input.keyId !== undefined) {
    const keyId = input.keyId.trim().toUpperCase();
    if (keyId && !APNS_KEY_OR_TEAM_ID.test(keyId)) {
      return { ok: false, error: "Key ID must be 10 uppercase letters or digits." };
    }
    normalized.keyId = keyId;
  }
  if (input.bundleId !== undefined) {
    const bundleId = input.bundleId.trim();
    if (bundleId && (bundleId.length > 155 || !APNS_BUNDLE_ID.test(bundleId))) {
      return { ok: false, error: "Bundle ID must look like com.example.mausbot." };
    }
    normalized.bundleId = bundleId;
  }
  if (input.privateKey !== undefined) {
    const trimmed = input.privateKey.trim();
    if (!trimmed) {
      normalized.privateKey = "";
    } else {
      const checked = validateApnsPrivateKey(trimmed);
      if (!checked.ok) return checked;
      normalized.privateKey = checked.pem;
    }
  }
  return { ok: true, normalized };
}

export function usableApnsPrivateKey(apns: ApnsConfig | undefined): string | undefined {
  const raw = apns?.privateKey?.trim();
  if (!raw) return undefined;
  const checked = validateApnsPrivateKey(raw);
  return checked.ok ? checked.pem : undefined;
}

export function resolveApnsConfig(apns: ApnsConfig | undefined): ResolvedApnsConfig | null {
  if (!apns || apns.enabled === false) return null;
  const teamId = apns.teamId?.trim().toUpperCase() ?? "";
  const keyId = apns.keyId?.trim().toUpperCase() ?? "";
  const bundleId = apns.bundleId?.trim() ?? "";
  const rawKey = apns.privateKey?.trim() ?? "";
  if (!APNS_KEY_OR_TEAM_ID.test(teamId) || !APNS_KEY_OR_TEAM_ID.test(keyId)) return null;
  if (!bundleId || bundleId.length > 155 || !APNS_BUNDLE_ID.test(bundleId)) return null;
  const checked = validateApnsPrivateKey(rawKey);
  if (!checked.ok) return null;
  return {
    teamId,
    keyId,
    bundleId,
    privateKey: checked.pem,
    defaultEnvironment: apns.environment === "production" ? "production" : "sandbox",
    includePreview: apns.includePreview !== false,
  };
}

export function apnsConfigWithEnv(apns: ApnsConfig | undefined, env: NodeJS.ProcessEnv = process.env): ApnsConfig {
  const next: ApnsConfig = { ...apns };
  const rawEnabled = env.OMB_APNS_ENABLED?.trim().toLowerCase();
  if (rawEnabled === "1" || rawEnabled === "true") next.enabled = true;
  else if (rawEnabled === "0" || rawEnabled === "false") next.enabled = false;
  const rawPreview = env.OMB_APNS_INCLUDE_PREVIEW?.trim().toLowerCase();
  if (rawPreview === "1" || rawPreview === "true") next.includePreview = true;
  else if (rawPreview === "0" || rawPreview === "false") next.includePreview = false;
  if (env.OMB_APNS_TEAM_ID !== undefined) next.teamId = env.OMB_APNS_TEAM_ID.trim().toUpperCase();
  if (env.OMB_APNS_KEY_ID !== undefined) next.keyId = env.OMB_APNS_KEY_ID.trim().toUpperCase();
  if (env.OMB_APNS_BUNDLE_ID !== undefined) next.bundleId = env.OMB_APNS_BUNDLE_ID.trim();
  const envEnvironment = env.OMB_APNS_ENVIRONMENT?.trim().toLowerCase();
  if (envEnvironment === "production" || envEnvironment === "sandbox") next.environment = envEnvironment;
  if (env.OMB_APNS_PRIVATE_KEY !== undefined) {
    next.privateKey = env.OMB_APNS_PRIVATE_KEY;
  } else if (env.OMB_APNS_PRIVATE_KEY_FILE?.trim()) {
    try {
      next.privateKey = readFileSync(env.OMB_APNS_PRIVATE_KEY_FILE.trim(), "utf8");
    } catch {
      next.privateKey = "";
    }
  }
  return next;
}

export interface ApnsSaveInput {
  enabled?: boolean;
  includePreview?: boolean;
  teamId?: string;
  keyId?: string;
  bundleId?: string;
  privateKey?: string;
  clearPrivateKey?: boolean;
  environment?: ApnsEnvironment;
}

export function apnsSavePatch(patch: ApnsSaveInput): ApnsConfig {
  const next: ApnsConfig = {};
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.includePreview !== undefined) next.includePreview = patch.includePreview;
  if (patch.teamId !== undefined) next.teamId = patch.teamId.trim().toUpperCase();
  if (patch.keyId !== undefined) next.keyId = patch.keyId.trim().toUpperCase();
  if (patch.bundleId !== undefined) next.bundleId = patch.bundleId.trim();
  if (patch.environment !== undefined) next.environment = patch.environment;
  if (patch.clearPrivateKey) next.privateKey = "";
  else if (patch.privateKey !== undefined) next.privateKey = patch.privateKey;
  return next;
}

export function apnsSettingEnv(apns: ApnsConfig | undefined): Array<[value: string | undefined, name: string]> {
  const enabled = apns?.enabled === undefined ? undefined : apns.enabled ? "1" : "0";
  const includePreview = apns?.includePreview === undefined ? undefined : apns.includePreview ? "1" : "0";
  return [
    [enabled, "OMB_APNS_ENABLED"],
    [includePreview, "OMB_APNS_INCLUDE_PREVIEW"],
    [apns?.teamId, "OMB_APNS_TEAM_ID"],
    [apns?.keyId, "OMB_APNS_KEY_ID"],
    [apns?.bundleId, "OMB_APNS_BUNDLE_ID"],
    [apns?.environment, "OMB_APNS_ENVIRONMENT"],
    [apns?.privateKey !== undefined ? "" : undefined, "OMB_APNS_PRIVATE_KEY_FILE"],
  ];
}
