#!/usr/bin/env node
// Patches a FairPlay-decrypted MausBot IPA to enable remote APNs alerts + ActivityKit Live Activity push tokens,
// aligns Bundle ID / App Group / Keychain Access Groups, and optionally re-signs with Apple provisioning profiles.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function plistToJson(plistPath) {
  const out = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath]);
  return JSON.parse(out);
}

export function writePlistFromObject(plistPath, value, format = "binary1") {
  const tempJson = `${plistPath}.tmp.json`;
  writeFileSync(tempJson, JSON.stringify(value, null, 2), "utf8");
  try {
    run("/usr/bin/plutil", ["-convert", format, "-o", plistPath, tempJson]);
  } finally {
    rmSync(tempJson, { force: true });
  }
}

export function verifyDecryptedMachO(binaryPath) {
  const out = run("/usr/bin/otool", ["-l", binaryPath]);
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.includes("LC_ENCRYPTION_INFO")) {
      const block = lines.slice(i, i + 8).join("\n");
      const match = /cryptid\s+(\d+)/.exec(block);
      if (match && Number(match[1]) !== 0) {
        throw new Error(`Binary is still FairPlay-encrypted (cryptid=${match[1]}): ${binaryPath}`);
      }
    }
  }
}

export function verifyDecryptedAppBundle(appDir) {
  const mainInfo = plistToJson(join(appDir, "Info.plist"));
  const mainExec = mainInfo.CFBundleExecutable || basename(appDir, ".app");
  verifyDecryptedMachO(join(appDir, mainExec));

  const pluginsDir = join(appDir, "PlugIns");
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir)) {
      if (!entry.endsWith(".appex")) continue;
      const extDir = join(pluginsDir, entry);
      const extPlist = join(extDir, "Info.plist");
      const extExec = existsSync(extPlist)
        ? (plistToJson(extPlist).CFBundleExecutable || basename(entry, ".appex"))
        : basename(entry, ".appex");
      const extBinary = join(extDir, extExec);
      if (existsSync(extBinary)) verifyDecryptedMachO(extBinary);
    }
  }

  const frameworksDir = join(appDir, "Frameworks");
  if (existsSync(frameworksDir)) {
    for (const entry of readdirSync(frameworksDir)) {
      const full = join(frameworksDir, entry);
      if (entry.endsWith(".dylib") && statSync(full).isFile()) {
        verifyDecryptedMachO(full);
      } else if (entry.endsWith(".framework") && statSync(full).isDirectory()) {
        const fwPlist = join(full, "Info.plist");
        const fwExec = existsSync(fwPlist)
          ? (plistToJson(fwPlist).CFBundleExecutable || basename(entry, ".framework"))
          : basename(entry, ".framework");
        const fwBinary = join(full, fwExec);
        if (existsSync(fwBinary) && statSync(fwBinary).isFile()) {
          verifyDecryptedMachO(fwBinary);
        }
      }
    }
  }
}

export function extractPlistEntitlements(plistPath, sourceLabel = plistPath) {
  let out;
  try {
    // Decoded `.mobileprovision` plists contain top-level `<date>` and `<data>` keys that
    // `plutil -convert json` rejects; `-extract Entitlements json` converts only the subtree.
    out = run("/usr/bin/plutil", ["-extract", "Entitlements", "json", "-o", "-", plistPath]);
  } catch {
    throw new Error(`No Entitlements dictionary found in provisioning profile: ${sourceLabel}`);
  }
  const entitlements = JSON.parse(out);
  if (!entitlements || typeof entitlements !== "object" || Array.isArray(entitlements)) {
    throw new Error(`No Entitlements dictionary found in provisioning profile: ${sourceLabel}`);
  }
  return entitlements;
}

export function extractMobileProvisionEntitlements(profilePath, outEntitlementsPlist) {
  const decodedXml = run("/usr/bin/security", ["cms", "-D", "-i", profilePath]);
  const tempPlist = `${outEntitlementsPlist ?? profilePath}.profile.${process.pid}.plist`;
  writeFileSync(tempPlist, decodedXml, "utf8");
  try {
    const entitlements = extractPlistEntitlements(tempPlist, profilePath);
    if (outEntitlementsPlist) {
      writePlistFromObject(outEntitlementsPlist, entitlements, "xml1");
    }
    return entitlements;
  } finally {
    rmSync(tempPlist, { force: true });
  }
}

function normalizeEnvironment(raw) {
  const env = raw === undefined ? "sandbox" : String(raw).trim().toLowerCase();
  if (env !== "sandbox" && env !== "production") {
    throw new Error(`Invalid --environment "${raw}" (expected "sandbox" or "production").`);
  }
  return env;
}

function matchesEntitlementPattern(pattern, value) {
  if (typeof pattern !== "string") return false;
  const trimmed = pattern.trim();
  return trimmed === value || (trimmed.endsWith("*") && value.startsWith(trimmed.slice(0, -1)));
}

export function validateProvisionEntitlements(entitlements, { label, teamId, bundleId, appGroup, expectedAps, requireKeychainGroups }) {
  if (expectedAps) {
    const apsEnv = entitlements["aps-environment"];
    if (!apsEnv) {
      throw new Error(`${label} provisioning profile does not include the Push Notifications entitlement (aps-environment). Enable Push Notifications on your App ID in Apple Developer Portal and regenerate the profile.`);
    }
    if (apsEnv !== expectedAps) {
      throw new Error(`${label} provisioning profile aps-environment is "${apsEnv}", which does not match --environment (expected "${expectedAps}").`);
    }
  }
  const profileTeam = entitlements["com.apple.developer.team-identifier"];
  if (typeof profileTeam === "string" && profileTeam.trim() && profileTeam.trim() !== teamId) {
    throw new Error(`${label} provisioning profile team-identifier is "${profileTeam.trim()}", expected "${teamId}".`);
  }
  const expectedAppId = `${teamId}.${bundleId}`;
  const actualAppId = typeof entitlements["application-identifier"] === "string" ? entitlements["application-identifier"].trim() : "";
  if (!matchesEntitlementPattern(actualAppId, expectedAppId)) {
    throw new Error(`${label} provisioning profile application-identifier is "${actualAppId || "(missing)"}", expected "${expectedAppId}".`);
  }
  const groups = entitlements["com.apple.security.application-groups"];
  if (!Array.isArray(groups) || !groups.includes(appGroup)) {
    throw new Error(`${label} provisioning profile com.apple.security.application-groups does not include "${appGroup}". Enable App Groups on the App ID in Apple Developer Portal and regenerate the profile.`);
  }
  if (requireKeychainGroups && Array.isArray(entitlements["keychain-access-groups"])) {
    const allowed = entitlements["keychain-access-groups"];
    for (const requiredGroup of [`${teamId}.${bundleId}`, `${teamId}.${appGroup}`]) {
      const authorizedByAppGroup = requiredGroup === `${teamId}.${appGroup}` && groups.includes(appGroup);
      const authorized = allowed.some((entry) => matchesEntitlementPattern(entry, requiredGroup)) || authorizedByAppGroup;
      if (!authorized) {
        throw new Error(`${label} provisioning profile keychain-access-groups does not authorize "${requiredGroup}".`);
      }
    }
  }
}

/**
 * Builds concrete signing entitlements without profile-only wildcards (`TEAMID.*`).
 * Passing raw `.mobileprovision` wildcards into `codesign --entitlements` causes
 * `installd` (`0xe8008016`) or Keychain `-34018` (`errSecMissingEntitlement`) because
 * `securityd` compares `kSecAttrAccessGroup` against signed entitlements literally.
 */
export function buildSigningEntitlements(
  profileEntitlements,
  { teamId, bundleId, appGroup, expectedAps, includeKeychainGroups = false },
) {
  const signed = {
    "application-identifier": `${teamId}.${bundleId}`,
    "com.apple.developer.team-identifier": teamId,
    "com.apple.security.application-groups": [appGroup],
  };
  if (includeKeychainGroups) {
    signed["keychain-access-groups"] = Array.from(new Set([
      `${teamId}.${bundleId}`,
      `${teamId}.${appGroup}`,
    ]));
  }
  if (expectedAps) {
    signed["aps-environment"] = expectedAps;
    if (profileEntitlements?.["com.apple.developer.usernotifications.time-sensitive"] === true) {
      signed["com.apple.developer.usernotifications.time-sensitive"] = true;
    }
  }
  if (typeof profileEntitlements?.["get-task-allow"] === "boolean") {
    signed["get-task-allow"] = profileEntitlements["get-task-allow"];
  }
  if (profileEntitlements?.["beta-reports-active"] === true) {
    signed["beta-reports-active"] = true;
  }
  return signed;
}

export function patchExtractedAppBundle(appDir, options) {
  const teamId = String(options.teamId ?? "").trim().toUpperCase();
  const bundleId = String(options.bundleId ?? "").trim();
  const environment = normalizeEnvironment(options.environment);
  const appGroup = String(options.appGroup ?? `group.${bundleId}`).trim();
  const stripShareExtension = Boolean(options.stripShareExtension);
  const stripWidgetsExtension = Boolean(options.stripWidgetsExtension);

  if (!TEAM_ID_RE.test(teamId)) throw new Error(`Invalid --team-id "${teamId}" (expected 10 uppercase letters/digits).`);
  if (!BUNDLE_ID_RE.test(bundleId)) throw new Error(`Invalid --bundle-id "${bundleId}".`);
  if (!appGroup.startsWith("group.")) throw new Error(`Invalid --app-group "${appGroup}" (must start with "group.").`);

  const infoPlistPath = join(appDir, "Info.plist");
  if (!existsSync(infoPlistPath)) throw new Error(`Missing Info.plist in ${appDir}`);
  const info = plistToJson(infoPlistPath);
  info.CFBundleIdentifier = bundleId;
  info.OpenMausAppGroup = appGroup;
  info.ExpoWidgetsAppGroupIdentifier = appGroup;
  info.ExpoShareIntoAppGroupId = appGroup;
  // iOS Keychain (-34018 errSecMissingEntitlement) occurs unless these match the re-signing Team ID + App Group.
  info.OpenMausKeychainAccessGroup = `${teamId}.${appGroup}`;
  info.OpenMausLegacyKeychainAccessGroup = `${teamId}.${bundleId}`;
  // Enables ActivityKit remote push tokens and frequent APNs updates inside ExpoWidgets.LiveActivityFactory.
  info.ExpoWidgets_EnablePushNotifications = true;
  info.NSSupportsLiveActivities = true;
  info.NSSupportsLiveActivitiesFrequentUpdates = true;
  const bgModes = Array.isArray(info.UIBackgroundModes) ? [...info.UIBackgroundModes] : [];
  if (!bgModes.includes("remote-notification")) bgModes.push("remote-notification");
  info.UIBackgroundModes = bgModes;
  writePlistFromObject(infoPlistPath, info, "binary1");

  const appConfigPath = join(appDir, "EXConstants.bundle", "app.config");
  if (!existsSync(appConfigPath)) throw new Error(`Missing EXConstants.bundle/app.config in ${appDir}`);
  const appConfig = JSON.parse(readFileSync(appConfigPath, "utf8"));
  appConfig.scheme = "openmausbot";
  appConfig.ios = {
    ...appConfig.ios,
    bundleIdentifier: bundleId,
    infoPlist: {
      ...appConfig.ios?.infoPlist,
      NSSupportsLiveActivities: true,
      NSSupportsLiveActivitiesFrequentUpdates: true,
      OpenMausAppGroup: appGroup,
      OpenMausKeychainAccessGroup: `${teamId}.${appGroup}`,
      OpenMausLegacyKeychainAccessGroup: `${teamId}.${bundleId}`,
    },
  };
  appConfig.extra = {
    ...appConfig.extra,
    remotePush: {
      enabled: true,
      apnsEnvironment: environment,
    },
  };
  writeFileSync(appConfigPath, JSON.stringify(appConfig), "utf8");

  const widgetsDir = join(appDir, "PlugIns", "ExpoWidgetsTarget.appex");
  if (existsSync(widgetsDir)) {
    if (stripWidgetsExtension) {
      rmSync(widgetsDir, { recursive: true, force: true });
    } else {
      const widgetsPlistPath = join(widgetsDir, "Info.plist");
      const widgetsInfo = plistToJson(widgetsPlistPath);
      widgetsInfo.CFBundleIdentifier = `${bundleId}.widgets`;
      widgetsInfo.ExpoWidgetsAppGroupIdentifier = appGroup;
      writePlistFromObject(widgetsPlistPath, widgetsInfo, "binary1");
    }
  }

  const shareDir = join(appDir, "PlugIns", "expo-sharing-extension.appex");
  if (existsSync(shareDir)) {
    if (stripShareExtension) {
      rmSync(shareDir, { recursive: true, force: true });
    } else {
      const sharePlistPath = join(shareDir, "Info.plist");
      const shareInfo = plistToJson(sharePlistPath);
      shareInfo.CFBundleIdentifier = `${bundleId}.share`;
      shareInfo.AppGroupId = appGroup;
      writePlistFromObject(sharePlistPath, shareInfo, "binary1");
    }
  }

  return {
    bundleId,
    teamId,
    appGroup,
    environment,
    widgetsBundleId: existsSync(widgetsDir) ? `${bundleId}.widgets` : null,
    shareBundleId: existsSync(shareDir) ? `${bundleId}.share` : null,
  };
}

function codesignPath(targetPath, identity, entitlementsPath) {
  if (statSync(targetPath).isDirectory()) {
    rmSync(join(targetPath, "_CodeSignature"), { recursive: true, force: true });
  }
  const args = ["--force", "--sign", identity, "--generate-entitlement-der"];
  if (entitlementsPath) args.push("--entitlements", entitlementsPath);
  run("/usr/bin/codesign", [...args, targetPath]);
}

export function resignAppBundle(appDir, options, scratchDir) {
  const { identity, mainProfile, widgetsProfile, shareProfile } = options;
  const teamId = String(options.teamId ?? "").trim().toUpperCase();
  const bundleId = String(options.bundleId ?? "").trim();
  const appGroup = String(options.appGroup ?? `group.${bundleId}`).trim();
  const environment = normalizeEnvironment(options.environment);
  if (!identity) throw new Error("Missing --identity for codesigning (or pass --patch-only).");
  if (!mainProfile || !existsSync(mainProfile)) throw new Error(`Missing main provisioning profile: ${mainProfile ?? "(unset)"}`);

  const mainEntitlementsPath = join(scratchDir, "main.entitlements.plist");
  const mainEnt = extractMobileProvisionEntitlements(mainProfile);
  const expectedAps = environment === "production" ? "production" : "development";
  validateProvisionEntitlements(mainEnt, {
    label: "Main",
    teamId,
    bundleId,
    appGroup,
    expectedAps,
    requireKeychainGroups: true,
  });
  const signedMainEnt = buildSigningEntitlements(mainEnt, {
    teamId,
    bundleId,
    appGroup,
    expectedAps,
    includeKeychainGroups: true,
  });
  writePlistFromObject(mainEntitlementsPath, signedMainEnt, "xml1");

  const frameworksDir = join(appDir, "Frameworks");
  if (existsSync(frameworksDir)) {
    for (const entry of readdirSync(frameworksDir)) {
      const full = join(frameworksDir, entry);
      if (entry.endsWith(".framework") || entry.endsWith(".dylib")) {
        codesignPath(full, identity);
      }
    }
  }

  const widgetsDir = join(appDir, "PlugIns", "ExpoWidgetsTarget.appex");
  if (existsSync(widgetsDir)) {
    if (!widgetsProfile || !existsSync(widgetsProfile)) {
      throw new Error("PlugIns/ExpoWidgetsTarget.appex is present; supply --widgets-profile <path> (needed for Dynamic Island / Live Activity) or pass --strip-widgets-extension.");
    }
    const widgetsEntPath = join(scratchDir, "widgets.entitlements.plist");
    const widgetsEnt = extractMobileProvisionEntitlements(widgetsProfile);
    const widgetsBundleId = `${bundleId}.widgets`;
    validateProvisionEntitlements(widgetsEnt, { label: "Widgets", teamId, bundleId: widgetsBundleId, appGroup });
    const signedWidgetsEnt = buildSigningEntitlements(widgetsEnt, {
      teamId,
      bundleId: widgetsBundleId,
      appGroup,
    });
    writePlistFromObject(widgetsEntPath, signedWidgetsEnt, "xml1");
    copyFileSync(widgetsProfile, join(widgetsDir, "embedded.mobileprovision"));
    codesignPath(widgetsDir, identity, widgetsEntPath);
  }

  const shareDir = join(appDir, "PlugIns", "expo-sharing-extension.appex");
  if (existsSync(shareDir)) {
    if (!shareProfile || !existsSync(shareProfile)) {
      throw new Error("PlugIns/expo-sharing-extension.appex is present; supply --share-profile <path> or pass --strip-share-extension.");
    }
    const shareEntPath = join(scratchDir, "share.entitlements.plist");
    const shareEnt = extractMobileProvisionEntitlements(shareProfile);
    const shareBundleId = `${bundleId}.share`;
    validateProvisionEntitlements(shareEnt, { label: "Share extension", teamId, bundleId: shareBundleId, appGroup });
    const signedShareEnt = buildSigningEntitlements(shareEnt, {
      teamId,
      bundleId: shareBundleId,
      appGroup,
    });
    writePlistFromObject(shareEntPath, signedShareEnt, "xml1");
    copyFileSync(shareProfile, join(shareDir, "embedded.mobileprovision"));
    codesignPath(shareDir, identity, shareEntPath);
  }

  copyFileSync(mainProfile, join(appDir, "embedded.mobileprovision"));
  codesignPath(appDir, identity, mainEntitlementsPath);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appDir]);
}

export function processIpa(options) {
  const inputIpa = resolve(options.ipa);
  const outputIpa = resolve(options.out);
  if (!existsSync(inputIpa) || !statSync(inputIpa).isFile()) {
    throw new Error(`Input IPA not found: ${inputIpa}`);
  }
  const workDir = mkdtempSync(join(tmpdir(), "omb-ipa-apns-"));
  try {
    const extractDir = join(workDir, "extracted");
    run("/usr/bin/ditto", ["-x", "-k", inputIpa, extractDir]);
    const payloadDir = join(extractDir, "Payload");
    const appEntry = readdirSync(payloadDir).find((name) => name.endsWith(".app"));
    if (!appEntry) throw new Error("IPA Payload directory does not contain a .app bundle.");
    const appDir = join(payloadDir, appEntry);

    const summary = patchExtractedAppBundle(appDir, options);
    verifyDecryptedAppBundle(appDir);
    if (!options.patchOnly) {
      resignAppBundle(appDir, options, workDir);
    }

    mkdirIfNeeded(dirname(outputIpa));
    rmSync(outputIpa, { force: true });
    run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", payloadDir, outputIpa]);
    return { ...summary, outputIpa, signed: !options.patchOnly };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function mkdirIfNeeded(dir) {
  execFileSync("/bin/mkdir", ["-p", dir]);
}

function parseCliArgs(argv) {
  const out = {
    environment: "sandbox",
    patchOnly: false,
    stripShareExtension: false,
    stripWidgetsExtension: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const val = argv[++i];
      if (!val) throw new Error(`Missing value after ${arg}`);
      return val;
    };
    if (arg === "--ipa") out.ipa = next();
    else if (arg === "--out") out.out = next();
    else if (arg === "--team-id") out.teamId = next();
    else if (arg === "--bundle-id") out.bundleId = next();
    else if (arg === "--app-group") out.appGroup = next();
    else if (arg === "--environment") out.environment = next();
    else if (arg === "--identity") out.identity = next();
    else if (arg === "--profile") out.mainProfile = next();
    else if (arg === "--widgets-profile") out.widgetsProfile = next();
    else if (arg === "--share-profile") out.shareProfile = next();
    else if (arg === "--patch-only") out.patchOnly = true;
    else if (arg === "--strip-share-extension") out.stripShareExtension = true;
    else if (arg === "--strip-widgets-extension") out.stripWidgetsExtension = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

const HELP = `Usage:
  node scripts/ios/resign-ipa-apns.mjs \\
    --ipa /path/to/MausBot.decrypted.ipa \\
    --out /path/to/MausBot-apns.ipa \\
    --team-id YOURTEAM10 \\
    --bundle-id com.yourname.mausbot \\
    [--app-group group.com.yourname.mausbot] \\
    [--environment sandbox|production] \\
    [--strip-share-extension] \\
    [--patch-only | --identity "Apple Development: ..." --profile main.mobileprovision --widgets-profile widgets.mobileprovision]
`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseCliArgs(process.argv.slice(2));
    if (parsed.help || !parsed.ipa || !parsed.out || !parsed.teamId || !parsed.bundleId) {
      process.stdout.write(HELP);
      process.exit(parsed.help ? 0 : 1);
    }
    const result = processIpa(parsed);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
