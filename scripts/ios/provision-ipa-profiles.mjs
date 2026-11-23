#!/usr/bin/env node
// Generates or refreshes Apple Development provisioning profiles (main app with Communication
// Notifications + Push + Live Activities + App Group, Widgets extension, and NotificationService
// extension) using Xcode's local `-allowProvisioningUpdates` session.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function xcodeEnv() {
  if (process.env.DEVELOPER_DIR) return process.env;
  const xcodeDev = "/Applications/Xcode.app/Contents/Developer";
  return existsSync(xcodeDev) ? { ...process.env, DEVELOPER_DIR: xcodeDev } : process.env;
}

export function provisionIpaProfiles({ teamId, bundleId, appGroup, udid, outDir }) {
  const cleanTeam = String(teamId ?? "").trim().toUpperCase();
  const cleanBundle = String(bundleId ?? "").trim();
  const cleanGroup = String(appGroup ?? `group.${cleanBundle}`).trim();
  const cleanUdid = String(udid ?? "").trim();
  if (!TEAM_ID_RE.test(cleanTeam)) throw new Error(`Invalid --team-id "${cleanTeam}".`);
  if (!BUNDLE_ID_RE.test(cleanBundle)) throw new Error(`Invalid --bundle-id "${cleanBundle}".`);
  if (!cleanGroup.startsWith("group.")) throw new Error(`Invalid --app-group "${cleanGroup}".`);

  const resolvedOut = resolve(outDir);
  mkdirSync(resolvedOut, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "omb-provision-gen-"));

  try {
    mkdirSync(join(workDir, "App"), { recursive: true });
    mkdirSync(join(workDir, "Widgets"), { recursive: true });
    mkdirSync(join(workDir, "NSE"), { recursive: true });

    writeFileSync(join(workDir, "App", "AppDelegate.swift"), "import UIKit\n@main class D: UIResponder, UIApplicationDelegate {}\n");
    writeFileSync(join(workDir, "App", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleName</key><string>MausBot</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSSupportsLiveActivities</key><true/>
  <key>NSSupportsLiveActivitiesFrequentUpdates</key><true/>
  <key>NSUserActivityTypes</key><array><string>INSendMessageIntent</string></array>
  <key>UIBackgroundModes</key><array><string>remote-notification</string></array>
</dict></plist>\n`);
    writeFileSync(join(workDir, "App", "App.entitlements"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>aps-environment</key><string>development</string>
  <key>com.apple.developer.usernotifications.communication</key><true/>
  <key>com.apple.security.application-groups</key><array><string>${cleanGroup}</string></array>
</dict></plist>\n`);

    writeFileSync(join(workDir, "Widgets", "W.swift"), "import WidgetKit\nimport SwiftUI\n@main struct W: Widget { var body: some WidgetConfiguration { StaticConfiguration(kind: \"k\", provider: P()) { _ in EmptyView() } } }\nstruct E: TimelineEntry { let date = Date() }\nstruct P: TimelineProvider { func placeholder(in c: Context) -> E { E() }; func getSnapshot(in c: Context, completion: @escaping (E) -> Void) { completion(E()) }; func getTimeline(in c: Context, completion: @escaping (Timeline<E>) -> Void) { completion(Timeline(entries: [E()], policy: .never)) } }\n");
    writeFileSync(join(workDir, "Widgets", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleName</key><string>Widgets</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>2.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string></dict>
</dict></plist>\n`);
    writeFileSync(join(workDir, "Widgets", "Widgets.entitlements"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.application-groups</key><array><string>${cleanGroup}</string></array>
</dict></plist>\n`);

    writeFileSync(join(workDir, "NSE", "NotificationService.swift"), "import UserNotifications\n@objc(NotificationService) class NotificationService: UNNotificationServiceExtension {}\n");
    writeFileSync(join(workDir, "NSE", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleName</key><string>NotificationService</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>2.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSExtension</key><dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key><string>NotificationService</string>
  </dict>
</dict></plist>\n`);
    writeFileSync(join(workDir, "NSE", "NSE.entitlements"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.application-groups</key><array><string>${cleanGroup}</string></array>
</dict></plist>\n`);

    mkdirSync(join(workDir, "Gen.xcodeproj"), { recursive: true });
    writeFileSync(join(workDir, "Gen.xcodeproj", "project.pbxproj"), `// !$*UTF8*$!
{
  archiveVersion = 1; classes = {}; objectVersion = 56;
  objects = {
    A1 = {isa = PBXBuildFile; fileRef = F1; };
    A2 = {isa = PBXBuildFile; fileRef = F2; };
    A3 = {isa = PBXBuildFile; fileRef = F3; };
    A4 = {isa = PBXBuildFile; fileRef = P2; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };
    A5 = {isa = PBXBuildFile; fileRef = P3; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };
    F1 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = App/AppDelegate.swift; sourceTree = "<group>"; };
    F2 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = Widgets/W.swift; sourceTree = "<group>"; };
    F3 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = NSE/NotificationService.swift; sourceTree = "<group>"; };
    P1 = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = App.app; sourceTree = BUILT_PRODUCTS_DIR; };
    P2 = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = Widgets.appex; sourceTree = BUILT_PRODUCTS_DIR; };
    P3 = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = NotificationService.appex; sourceTree = BUILT_PRODUCTS_DIR; };
    G0 = {isa = PBXGroup; children = (F1, F2, F3, P1, P2, P3); sourceTree = "<group>"; };
    E1 = {isa = PBXCopyFilesBuildPhase; buildActionMask = 2147483647; dstPath = ""; dstSubfolderSpec = 13; files = (A4, A5); name = "Embed App Extensions"; runOnlyForDeploymentPostprocessing = 0; };
    S1 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (A1); runOnlyForDeploymentPostprocessing = 0; };
    S2 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (A2); runOnlyForDeploymentPostprocessing = 0; };
    S3 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (A3); runOnlyForDeploymentPostprocessing = 0; };
    D2 = {isa = PBXTargetDependency; target = T2; };
    D3 = {isa = PBXTargetDependency; target = T3; };
    T1 = {isa = PBXNativeTarget; buildConfigurationList = CL1; buildPhases = (S1, E1); buildRules = (); dependencies = (D2, D3); name = App; productName = App; productReference = P1; productType = "com.apple.product-type.application"; };
    T2 = {isa = PBXNativeTarget; buildConfigurationList = CL2; buildPhases = (S2); buildRules = (); dependencies = (); name = Widgets; productName = Widgets; productReference = P2; productType = "com.apple.product-type.app-extension"; };
    T3 = {isa = PBXNativeTarget; buildConfigurationList = CL3; buildPhases = (S3); buildRules = (); dependencies = (); name = NotificationService; productName = NotificationService; productReference = P3; productType = "com.apple.product-type.app-extension"; };
    PRJ = {isa = PBXProject; attributes = {BuildIndependentTargetsInParallel = 1; LastUpgradeCheck = 1600; TargetAttributes = {T1 = {ProvisioningStyle = Automatic; DevelopmentTeam = ${cleanTeam}; }; T2 = {ProvisioningStyle = Automatic; DevelopmentTeam = ${cleanTeam}; }; T3 = {ProvisioningStyle = Automatic; DevelopmentTeam = ${cleanTeam}; }; }; }; buildConfigurationList = CL0; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en); mainGroup = G0; targets = (T1, T2, T3); };
    C0 = {isa = XCBuildConfiguration; buildSettings = {IPHONEOS_DEPLOYMENT_TARGET = 16.0; SDKROOT = iphoneos; SWIFT_VERSION = 5.0; DEVELOPMENT_TEAM = ${cleanTeam}; CODE_SIGN_STYLE = Automatic; }; name = Debug; };
    C1 = {isa = XCBuildConfiguration; buildSettings = {INFOPLIST_FILE = App/Info.plist; CODE_SIGN_ENTITLEMENTS = App/App.entitlements; PRODUCT_BUNDLE_IDENTIFIER = ${cleanBundle}; PRODUCT_NAME = App; }; name = Debug; };
    C2 = {isa = XCBuildConfiguration; buildSettings = {INFOPLIST_FILE = Widgets/Info.plist; CODE_SIGN_ENTITLEMENTS = Widgets/Widgets.entitlements; PRODUCT_BUNDLE_IDENTIFIER = ${cleanBundle}.widgets; PRODUCT_NAME = Widgets; SKIP_INSTALL = YES; }; name = Debug; };
    C3 = {isa = XCBuildConfiguration; buildSettings = {INFOPLIST_FILE = NSE/Info.plist; CODE_SIGN_ENTITLEMENTS = NSE/NSE.entitlements; PRODUCT_BUNDLE_IDENTIFIER = ${cleanBundle}.notification-service; PRODUCT_NAME = NotificationService; SKIP_INSTALL = YES; LD_RUNPATH_SEARCH_PATHS = "@executable_path/../../Frameworks"; }; name = Debug; };
    CL0 = {isa = XCConfigurationList; buildConfigurations = (C0); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
    CL1 = {isa = XCConfigurationList; buildConfigurations = (C1); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
    CL2 = {isa = XCConfigurationList; buildConfigurations = (C2); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
    CL3 = {isa = XCConfigurationList; buildConfigurations = (C3); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
  };
  rootObject = PRJ;
}
`);

    const derived = join(workDir, "Derived");
    const destination = cleanUdid ? `id=${cleanUdid}` : "generic/platform=iOS";
    execFileSync("/usr/bin/xcrun", [
      "xcodebuild",
      "-project", join(workDir, "Gen.xcodeproj"),
      "-scheme", "App",
      "-configuration", "Debug",
      "-destination", destination,
      "-derivedDataPath", derived,
      "-allowProvisioningUpdates",
      "build",
    ], { encoding: "utf8", env: xcodeEnv(), stdio: ["ignore", "pipe", "pipe"] });

    const builtApp = join(derived, "Build", "Products", "Debug-iphoneos", "App.app");
    const mainOut = join(resolvedOut, "main.mobileprovision");
    const widgetsOut = join(resolvedOut, "widgets.mobileprovision");
    const nseOut = join(resolvedOut, "nse.mobileprovision");
    copyFileSync(join(builtApp, "embedded.mobileprovision"), mainOut);
    copyFileSync(join(builtApp, "PlugIns", "Widgets.appex", "embedded.mobileprovision"), widgetsOut);
    copyFileSync(join(builtApp, "PlugIns", "NotificationService.appex", "embedded.mobileprovision"), nseOut);
    return { mainProfile: mainOut, widgetsProfile: widgetsOut, nseProfile: nseOut };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const val = argv[++i];
      if (!val) throw new Error(`Missing value after ${arg}`);
      return val;
    };
    if (arg === "--team-id") out.teamId = next();
    else if (arg === "--bundle-id") out.bundleId = next();
    else if (arg === "--app-group") out.appGroup = next();
    else if (arg === "--udid") out.udid = next();
    else if (arg === "--out-dir") out.outDir = next();
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.teamId || !args.bundleId || !args.outDir) {
    process.stdout.write(
      "Usage: node scripts/ios/provision-ipa-profiles.mjs --team-id TEAMID10 --bundle-id com.example.app [--app-group group.com.example.app] [--udid DEVICE_UDID] --out-dir /path/to/profiles\n",
    );
    process.exit(args.help ? 0 : 1);
  }
  const res = provisionIpaProfiles(args);
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
}
