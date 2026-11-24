# iOS 背景通知與靈動島（Live Activity）本地直連 APNs 設定指南

OpenMausBot 支援透過你自己的 **Apple Developer `.p8` 推播金鑰（APNs AuthKey）**，直接從本地電腦向已配對的 iPhone / iPad 發送：

1. **關掉 App 後的三層豐富背景通知（Communication Notification + 機器人頭像）**：支援 `approval`（需要核准）、`question`（機器人提問）、`sign-in` / `secret`（需要登入或提供憑證）、`done` / `brief` / `delegation-settled`（回覆與定時簡報完成）、`turn-failed` / `routine-failed` / `routine-deferred` / `incident` / `spend` / `notice`（異常、排程與額度提醒）與 `mention`（群組點名），以 iOS Communication Notification 顯示 **機器人專屬頭像/吉祥物圖示 + 機器人名稱 + 對話主題副標題 + 回覆/請求摘要預覽**（亦可在設定中關閉預覽切換為純無內容隱私模式）。
2. **鎖屏即時動態與靈動島全生命週期（ActivityKit Live Activity Push）**：在背景執行超過 1.5 秒時自動遠端喚起靈動島（`push-to-start`）、自動回報實例專屬更新 Token 並保護背景靈動島不被誤關、每 6 秒節流推送目前工具步驟、卡在核准/提問時顯示具體原因與雙膠囊操作按鈕、完成時顯示 `✓` 勾勾與完成摘要停留 30 秒後自動收合。

全程由你的電腦直連 Apple APNs，不經過任何第三方中繼伺服器。

---

## 第一步：在 Apple Developer Portal 建立憑證與 App ID

> **注意**：Apple 免費個人帳號（Personal Team）不支援 `Push Notifications`（`aps-environment`）權限；需具備付費 Apple Developer Program 帳號。

1. **建立 APNs AuthKey（`.p8`）**：
   - 前往 [Certificates, Identifiers & Profiles → Keys](https://developer.apple.com/account/resources/authkeys/list) 點擊 **+**。
   - 勾選 **Apple Push Notifications service (APNs)**，下載 `AuthKey_XXXXXXXXXX.p8`，並記下 **10 碼 Key ID** 與右上角的 **10 碼 Team ID**。
   - 同一把 `.p8` 金鑰同時支援一般背景推播（`<bundleId>`）與靈動島推播（`<bundleId>.push-type.liveactivity`）。

2. **建立 App Group**：
   - 前往 **Identifiers → App Groups**，新增例如 `group.com.yourname.mausbot`。

3. **建立 App IDs**：
   - **主程式 App ID**（例如 `com.yourname.mausbot`）：勾選 **Push Notifications**、**Communication Notifications** 與 **App Groups**（綁定上面的 `group.com.yourname.mausbot`）。
   - **靈動島 Widget Extension App ID**（例如 `com.yourname.mausbot.widgets`）：勾選 **App Groups**（綁定同一個 `group.com.yourname.mausbot`）。
   - **機器人頭像通知擴充 App ID**（例如 `com.yourname.mausbot.notification-service`）：勾選 **App Groups**（綁定同一個 `group.com.yourname.mausbot`），讓背景推播也能動態繪製機器人頭像與名稱。
   - *(選用)* 若想保留系統分享選單擴充功能，再建立 `com.yourname.mausbot.share` 並勾選同一個 **App Groups**；否則重簽時加上 `--strip-share-extension` 即可省去第 4 個描述檔。

4. **自動或手動產生 Provisioning Profiles（若使用命令列 `codesign`）**：
   - **自動產生（推薦）**：若本機 Xcode 已登入 Apple Developer 帳號並連接 iPhone，可直接執行：
     ```bash
     node scripts/ios/provision-ipa-profiles.mjs \
       --team-id YOURTEAM10 \
       --bundle-id com.yourname.mausbot
     ```
     Xcode 會自動註冊 App IDs / Capabilities 並下載主程式、`.widgets` 與 `.notification-service` 的 `.mobileprovision`。
   - **手動產生**：為 `com.yourname.mausbot`、`com.yourname.mausbot.widgets` 與 `com.yourname.mausbot.notification-service` 分別建立 **iOS App Development**（對應 `sandbox`）或 **Ad Hoc**（對應 `production`）描述檔（`.mobileprovision`），並勾選你的 iPhone UDID。

---

## 第二步：修補與重簽脫殼版 MausBot IPA

MausBot v2.0.0 App Store 版預設關閉了 `extra.remotePush.enabled` 與 `ExpoWidgets_EnablePushNotifications`。請使用內建腳本 `scripts/ios/resign-ipa-apns.mjs` 一鍵修補：

### 方式 A：只修補 IPA，交給 Feather / Sideloadly / ESign / AltStore 重簽（`--patch-only`）

```bash
node scripts/ios/resign-ipa-apns.mjs \
  --ipa ~/Downloads/MausBot-decrypted.ipa \
  --out ~/Downloads/MausBot-apns-patched.ipa \
  --team-id YOURTEAM10 \
  --bundle-id com.yourname.mausbot \
  --environment sandbox \
  --strip-share-extension \
  --patch-only
```

接著用你慣用的簽名工具（務必使用含有 `aps-environment` Push Notifications 權限的描述檔，並保持相同的 Bundle ID 與 Team ID）簽名安裝到 iPhone。

### 方式 B：在 macOS 直接完成修補 + `codesign` 重簽

```bash
node scripts/ios/resign-ipa-apns.mjs \
  --ipa ~/Downloads/MausBot-decrypted.ipa \
  --out ~/Downloads/MausBot-apns-signed.ipa \
  --team-id YOURTEAM10 \
  --bundle-id com.yourname.mausbot \
  --environment sandbox \
  --strip-share-extension \
  --identity "Apple Development: Your Name (XXXXXXXXXX)" \
  --profile ~/Downloads/MausBot_Dev.mobileprovision \
  --widgets-profile ~/Downloads/MausBot_Widgets_Dev.mobileprovision \
  --nse-profile ~/Downloads/MausBot_NSE_Dev.mobileprovision
```

簽名完成後，可用 **Xcode → Window → Devices and Simulators** 或 **Apple Configurator** 安裝 `MausBot-2.0.0-apns-signed.ipa`。

### 腳本自動修補的項目

- `EXConstants.bundle/app.config`：開啟 `extra.remotePush = { enabled: true, apnsEnvironment }`，並將 `scheme` 對齊為 `"openmausbot"`，確保點擊推播或靈動島能跳回對應對話。
- `MausBot.app/Info.plist`：
  - 開啟 `ExpoWidgets_EnablePushNotifications = true`（啟用靈動島 ActivityKit 遠端推播 Token）。
  - 開啟 `NSSupportsLiveActivities = true` 與 `NSSupportsLiveActivitiesFrequentUpdates = true`（解鎖 iOS「設定 → App → MausBot → 即時動態 → 更頻繁的更新」高頻更新預算）。
  - 在 `UIBackgroundModes` 加入 `remote-notification`，並在 `NSUserActivityTypes` 加入 `INSendMessageIntent`（啟用 Communication Notification 機器人頭像橫幅）。
  - 將 `CFBundleIdentifier`、`OpenMausAppGroup`、`ExpoWidgetsAppGroupIdentifier`、`OpenMausKeychainAccessGroup`、`OpenMausLegacyKeychainAccessGroup` 對齊至你的 `Team ID` 與 `Bundle ID`（避免 iOS Keychain `-34018` `errSecMissingEntitlement` 閃退或無法儲存配對金鑰）。
- `PlugIns/ExpoWidgetsTarget.appex/Info.plist`：同步更新為 `<bundleId>.widgets` 與相同 App Group。
- 當提供 `--nse-profile` 時，自動編譯並嵌入 `PlugIns/NotificationService.appex`（遠端 APNs 機器人頭像與名稱升級擴充）與 `Frameworks/OmbNotificationAvatar.dylib`（App 前景/剛退背景 SSE 本地通知機器人頭像與名稱升級）。

---

## 第三步：在 OpenMausBot 設定 APNs 金鑰

### 方法 1：透過圖形介面（推薦）

1. 打開 OpenMausBot **Settings → Phone & devices（手機與裝置）**。
2. 展開 **iOS background notifications → Apple push key (.p8)**。
3. 填入：
   - **APNs environment**：Development 描述檔選 `Sandbox (Development)`；Ad Hoc 描述檔選 `Production`。
   - **Apple Team ID**：10 碼 Team ID。
   - **APNs Key ID**：10 碼 Key ID。
   - **App Bundle ID**：例如 `com.yourname.mausbot`。
   - **APNs AuthKey (.p8)**：點擊 **Choose .p8 file** 選擇 `AuthKey_XXXXXXXXXX.p8` 或直接貼上內容。
4. 點擊 **Save**。
5. 在 iPhone 打開重簽後的 MausBot 與這台電腦完成配對並允許通知權限，回到電腦點擊 **Send test notification** 即可收到測試推播！

### 方法 2：透過 `config.json` 或環境變數

在資料目錄的 `config.json` 中加入：

```json
{
  "apns": {
    "enabled": true,
    "teamId": "YOURTEAM10",
    "keyId": "YOURKEYID0",
    "bundleId": "com.yourname.mausbot",
    "environment": "sandbox",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
  }
}
```

或使用環境變數覆寫：

```bash
export OMB_APNS_ENABLED=1
export OMB_APNS_TEAM_ID="YOURTEAM10"
export OMB_APNS_KEY_ID="YOURKEYID0"
export OMB_APNS_BUNDLE_ID="com.yourname.mausbot"
export OMB_APNS_ENVIRONMENT="sandbox"
export OMB_APNS_PRIVATE_KEY_FILE="/path/to/AuthKey_YOURKEYID0.p8"
```
