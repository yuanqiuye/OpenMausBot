import Foundation
import Intents
import UIKit
import UserNotifications

public struct OmbBotVisual {
  public var botId: String
  public var botName: String
  public var roomName: String?
  public var colorHex: String
  public var gradientHex: [String]
  public var body: String
  public var faceInkHex: String
  public var mood: String
}

public enum OmbNotificationUpgrader {
  private static let cacheDefaultsKey = "omb.botVisuals.v1"
  private static let validBodies: Set<String> = [
    "blob", "capsule", "circle", "cursor", "diamond",
    "drop", "hexagon", "shield", "squircle", "star",
  ]
  private static let validMoods: Set<String> = ["idle", "needsYou", "unread", "working"]

  public static func resolvedAppGroup(from bundle: Bundle = .main) -> String? {
    if let group = bundle.object(forInfoDictionaryKey: "OpenMausAppGroup") as? String, !group.isEmpty {
      return group
    }
    if let group = bundle.object(forInfoDictionaryKey: "ExpoWidgetsAppGroupIdentifier") as? String, !group.isEmpty {
      return group
    }
    if bundle.bundleURL.pathExtension == "appex" {
      let parentURL = bundle.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
      if let parentBundle = Bundle(url: parentURL) {
        if let group = parentBundle.object(forInfoDictionaryKey: "OpenMausAppGroup") as? String, !group.isEmpty {
          return group
        }
        if let group = parentBundle.object(forInfoDictionaryKey: "ExpoWidgetsAppGroupIdentifier") as? String, !group.isEmpty {
          return group
        }
      }
    }
    return nil
  }

  public static func upgrade(
    content: UNNotificationContent,
    completion: @escaping (UNNotificationContent) -> Void
  ) {
    guard let mutable = content.mutableCopy() as? UNMutableNotificationContent else {
      completion(content)
      return
    }
    if (mutable.userInfo["ombUpgraded"] as? Bool) == true {
      completion(mutable)
      return
    }

    let extracted = extractMetadata(from: mutable)
    guard let meta = extracted, !meta.botName.isEmpty else {
      completion(mutable)
      return
    }

    let senderDisplayName: String = {
      if let room = meta.roomName, !room.isEmpty, room != meta.botName {
        return "\(meta.botName) · \(room)"
      }
      return meta.botName
    }()

    mutable.title = senderDisplayName
    mutable.body = formattedBody(
      originalBody: mutable.body,
      subtitle: mutable.subtitle,
      statusTitle: meta.statusTitle,
      botName: meta.botName,
      roomName: meta.roomName,
      kind: meta.kind
    )
    mutable.subtitle = ""
    var updatedUserInfo = mutable.userInfo
    updatedUserInfo["ombUpgraded"] = true
    mutable.userInfo = updatedUserInfo

    guard #available(iOS 15.0, *) else {
      completion(mutable)
      return
    }

    let pngData = renderAvatarPng(for: meta.visual)
    let inImage = pngData.map { INImage(imageData: $0) }
    let handleValue = meta.visual.botId.isEmpty ? meta.botName : meta.visual.botId
    let personHandle = INPersonHandle(value: handleValue, type: .unknown)
    let sender = INPerson(
      personHandle: personHandle,
      nameComponents: nil,
      displayName: senderDisplayName,
      image: inImage,
      contactIdentifier: nil,
      customIdentifier: handleValue,
      isMe: false,
      suggestionType: .none
    )

    let conversationId = meta.threadId.isEmpty ? handleValue : meta.threadId
    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: mutable.body,
      speakableGroupName: nil,
      conversationIdentifier: conversationId,
      serviceName: "MausBot",
      sender: sender,
      attachments: nil
    )
    if let inImage {
      intent.setImage(inImage, forParameterNamed: \.sender)
    }

    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate { _ in
      do {
        let upgraded = try mutable.updating(from: intent)
        if let upgradedMutable = upgraded.mutableCopy() as? UNMutableNotificationContent {
          var info = upgradedMutable.userInfo
          info["ombUpgraded"] = true
          upgradedMutable.userInfo = info
          completion(upgradedMutable)
        } else {
          completion(upgraded)
        }
      } catch {
        completion(mutable)
      }
    }
  }

  private struct ExtractedMetadata {
    var visual: OmbBotVisual
    var botName: String
    var roomName: String?
    var threadId: String
    var kind: String
    var statusTitle: String?
  }

  private static func extractMetadata(from content: UNNotificationContent) -> ExtractedMetadata? {
    let userInfo = content.userInfo
    let omb = userInfo["omb"] as? [String: Any]
    let expoBody = userInfo["body"] as? [String: Any]

    let kind = trimmed(omb?["kind"] as? String)
      ?? trimmed(expoBody?["kind"] as? String)
      ?? inferredKind(from: content.categoryIdentifier)
      ?? "done"

    if kind == "spend" {
      return nil
    }

    let botId = trimmed(omb?["botId"] as? String)
      ?? trimmed(expoBody?["botId"] as? String)
      ?? ""
    let threadId = trimmed(omb?["threadId"] as? String)
      ?? trimmed(expoBody?["threadId"] as? String)
      ?? trimmed(content.threadIdentifier)
      ?? ""
    let roomName = trimmed(omb?["roomName"] as? String)
      ?? trimmed(expoBody?["roomName"] as? String)
    let statusTitle = trimmed(omb?["statusTitle"] as? String)
      ?? trimmed(content.title)

    let appGroup = resolvedAppGroup()
    let defaults = appGroup.flatMap { UserDefaults(suiteName: $0) }
    let widgetBot = lookupWidgetBot(defaults: defaults, botId: botId, threadId: threadId, titleHint: statusTitle)
    let cachedBot = lookupCachedBot(defaults: defaults, botId: botId)

    var botName = trimmed(omb?["botName"] as? String)
      ?? trimmed(expoBody?["botName"] as? String)
      ?? widgetBot?.botName
      ?? cachedBot?.botName
      ?? inferredBotName(from: statusTitle)
      ?? ""
    if botName.isEmpty {
      return nil
    }

    let mood = moodForKind(kind)
    var visual: OmbBotVisual
    if let rawVisual = omb?["botVisual"] as? [String: Any] {
      let colorHex = sanitizedHex(rawVisual["color"] as? String) ?? widgetBot?.colorHex ?? "#10B981"
      let rawGrad = (rawVisual["gradient"] as? [String])?.compactMap(sanitizedHex) ?? []
      let gradientHex = rawGrad.count >= 3 ? Array(rawGrad.prefix(3)) : [colorHex, colorHex, colorHex]
      let rawBody = trimmed(rawVisual["body"] as? String) ?? "cursor"
      let body = validBodies.contains(rawBody) ? rawBody : "cursor"
      let faceInk = sanitizedHex(rawVisual["faceInk"] as? String) ?? defaultFaceInk(for: colorHex)
      let rawMood = trimmed(rawVisual["mood"] as? String) ?? mood
      visual = OmbBotVisual(
        botId: botId,
        botName: botName,
        roomName: roomName,
        colorHex: colorHex,
        gradientHex: gradientHex,
        body: body,
        faceInkHex: faceInk,
        mood: validMoods.contains(rawMood) ? rawMood : mood
      )
      persistCachedBot(defaults: defaults, visual: visual)
    } else if let widgetBot {
      botName = botName.isEmpty ? widgetBot.botName : botName
      visual = OmbBotVisual(
        botId: botId.isEmpty ? widgetBot.botId : botId,
        botName: botName,
        roomName: roomName,
        colorHex: widgetBot.colorHex,
        gradientHex: widgetBot.gradientHex,
        body: widgetBot.body,
        faceInkHex: widgetBot.faceInkHex,
        mood: mood
      )
    } else if let cachedBot {
      visual = OmbBotVisual(
        botId: botId,
        botName: botName,
        roomName: roomName,
        colorHex: cachedBot.colorHex,
        gradientHex: cachedBot.gradientHex,
        body: cachedBot.body,
        faceInkHex: cachedBot.faceInkHex,
        mood: mood
      )
    } else {
      let fallbackColor = "#10B981"
      visual = OmbBotVisual(
        botId: botId,
        botName: botName,
        roomName: roomName,
        colorHex: fallbackColor,
        gradientHex: ["#A7F3D0", "#10B981", "#047857"],
        body: "cursor",
        faceInkHex: "#FFFFFF",
        mood: mood
      )
    }

    return ExtractedMetadata(
      visual: visual,
      botName: botName,
      roomName: roomName,
      threadId: threadId,
      kind: kind,
      statusTitle: statusTitle
    )
  }

  private static func formattedBody(
    originalBody: String,
    subtitle: String,
    statusTitle: String?,
    botName: String,
    roomName: String?,
    kind: String
  ) -> String {
    let cleanBody = originalBody.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanSub = subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
    let distinctSub: String? = {
      guard !cleanSub.isEmpty, cleanSub != botName, cleanSub != roomName, cleanSub != cleanBody else {
        return nil
      }
      return cleanSub
    }()

    if kind != "done" {
      let actionLabel = strippedActionLabel(statusTitle: statusTitle, botName: botName, roomName: roomName)
      let contextParts = [actionLabel, distinctSub].compactMap { $0 }.filter { !$0.isEmpty }
      let contextLine = contextParts.joined(separator: " · ")
      if !contextLine.isEmpty {
        if cleanBody.isEmpty || cleanBody == contextLine {
          return contextLine
        }
        return "\(contextLine)\n\(cleanBody)"
      }
    }

    if let distinctSub {
      if cleanBody.isEmpty {
        return distinctSub
      }
      return "\(distinctSub)\n\(cleanBody)"
    }
    if !cleanBody.isEmpty {
      return cleanBody
    }
    return strippedActionLabel(statusTitle: statusTitle, botName: botName, roomName: roomName) ?? botName
  }

  private static func strippedActionLabel(statusTitle: String?, botName: String, roomName: String?) -> String? {
    guard var s = trimmed(statusTitle) else { return nil }
    if let room = roomName, !room.isEmpty, s.hasPrefix("\(room) · ") {
      s = String(s.dropFirst(room.count + 3)).trimmingCharacters(in: .whitespaces)
    }
    if s == botName { return nil }
    if s.hasPrefix("\(botName) · ") {
      s = String(s.dropFirst(botName.count + 3)).trimmingCharacters(in: .whitespaces)
    } else if s.hasPrefix("\(botName)'s ") {
      let rest = String(s.dropFirst(botName.count + 3)).trimmingCharacters(in: .whitespaces)
      s = rest.prefix(1).uppercased() + rest.dropFirst()
    } else if s.hasPrefix("\(botName)’s ") {
      let rest = String(s.dropFirst(botName.count + 3)).trimmingCharacters(in: .whitespaces)
      s = rest.prefix(1).uppercased() + rest.dropFirst()
    } else if s.hasPrefix(botName) {
      let rest = String(s.dropFirst(botName.count)).trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: ":：·-—")))
      if !rest.isEmpty {
        s = rest.prefix(1).uppercased() + rest.dropFirst()
      } else {
        return nil
      }
    }
    return s.isEmpty || s == botName ? nil : s
  }

  private static func inferredKind(from category: String) -> String? {
    switch category {
    case "OPENMAUSBOT_NEEDS_INPUT": return "approval"
    case "OPENMAUSBOT_ATTENTION": return "turn-failed"
    case "OPENMAUSBOT_DONE": return "done"
    default: return nil
    }
  }

  private static func moodForKind(_ kind: String) -> String {
    switch kind {
    case "approval", "question", "sign-in", "secret", "turn-failed", "routine-failed":
      return "needsYou"
    case "done":
      return "unread"
    default:
      return "idle"
    }
  }

  private static func inferredBotName(from title: String?) -> String? {
    guard let raw = trimmed(title) else { return nil }
    if let dotRange = raw.range(of: " · ") {
      let left = String(raw[..<dotRange.lowerBound]).trimmingCharacters(in: .whitespaces)
      if !left.isEmpty { return left }
    }
    return raw
  }

  private static func persistCachedBot(defaults: UserDefaults?, visual: OmbBotVisual) {
    guard let defaults, !visual.botId.isEmpty else { return }
    var map = (defaults.dictionary(forKey: cacheDefaultsKey) as? [String: [String: Any]]) ?? [:]
    map[visual.botId] = [
      "botName": visual.botName,
      "color": visual.colorHex,
      "gradient": visual.gradientHex,
      "body": visual.body,
      "faceInk": visual.faceInkHex,
    ]
    defaults.set(map, forKey: cacheDefaultsKey)
  }

  private static func lookupCachedBot(defaults: UserDefaults?, botId: String) -> OmbBotVisual? {
    guard let defaults, !botId.isEmpty,
          let map = defaults.dictionary(forKey: cacheDefaultsKey) as? [String: [String: Any]],
          let entry = map[botId],
          let color = sanitizedHex(entry["color"] as? String)
    else { return nil }
    let name = trimmed(entry["botName"] as? String) ?? ""
    let grad = (entry["gradient"] as? [String])?.compactMap(sanitizedHex) ?? [color, color, color]
    let rawBody = trimmed(entry["body"] as? String) ?? "cursor"
    let faceInk = sanitizedHex(entry["faceInk"] as? String) ?? defaultFaceInk(for: color)
    return OmbBotVisual(
      botId: botId,
      botName: name,
      roomName: nil,
      colorHex: color,
      gradientHex: grad.count >= 3 ? Array(grad.prefix(3)) : [color, color, color],
      body: validBodies.contains(rawBody) ? rawBody : "cursor",
      faceInkHex: faceInk,
      mood: "unread"
    )
  }

  private static func lookupWidgetBot(
    defaults: UserDefaults?,
    botId: String,
    threadId: String,
    titleHint: String?
  ) -> OmbBotVisual? {
    guard let defaults else { return nil }
    let timelineKeys = [
      "__expo_widgets_BotWidget_timeline",
      "__expo_widgets_UpdatesDigestWidget_timeline",
      "__expo_widgets_NeedsYouWidget_timeline",
      "__expo_widgets_WorkingMonitorWidget_timeline",
    ]
    for key in timelineKeys {
      guard let raw = defaults.object(forKey: key) else { continue }
      let candidates = extractChatDictionaries(from: raw)
      if let match = matchWidgetCandidate(candidates, botId: botId, threadId: threadId, titleHint: titleHint) {
        return match
      }
    }
    return nil
  }

  private static func extractChatDictionaries(from raw: Any) -> [[String: Any]] {
    if let data = raw as? Data,
       let json = try? JSONSerialization.jsonObject(with: data) {
      return extractChatDictionaries(from: json)
    }
    if let str = raw as? String,
       let data = str.data(using: .utf8),
       let json = try? JSONSerialization.jsonObject(with: data) {
      return extractChatDictionaries(from: json)
    }
    var out: [[String: Any]] = []
    if let arr = raw as? [Any] {
      for item in arr {
        out.append(contentsOf: extractChatDictionaries(from: item))
      }
    } else if let dict = raw as? [String: Any] {
      if dict["name"] is String, dict["color"] is String {
        out.append(dict)
      }
      for (_, child) in dict {
        if child is [Any] || child is [String: Any] || child is String || child is Data {
          out.append(contentsOf: extractChatDictionaries(from: child))
        }
      }
    }
    return out
  }

  private static func matchWidgetCandidate(
    _ candidates: [[String: Any]],
    botId: String,
    threadId: String,
    titleHint: String?
  ) -> OmbBotVisual? {
    let matching: [String: Any]? = candidates.first { item in
      let id = (item["id"] as? String) ?? ""
      let link = (item["link"] as? String) ?? ""
      if !botId.isEmpty && (id == botId || link.contains(botId)) {
        return true
      }
      if !threadId.isEmpty && (id == threadId || link.contains(threadId)) {
        return true
      }
      return false
    } ?? candidates.first { item in
      guard let hint = titleHint, let name = trimmed(item["name"] as? String) else { return false }
      return hint == name || hint.hasPrefix("\(name) ") || hint.hasPrefix("\(name)'") || hint.hasPrefix("\(name)’") || hint.hasSuffix(" · \(name)")
    }

    guard let hit = matching,
          let name = trimmed(hit["name"] as? String),
          let color = sanitizedHex(hit["color"] as? String)
    else { return nil }
    let rawBody = trimmed(hit["body"] as? String) ?? "cursor"
    let body = rawBody.isEmpty ? "" : (validBodies.contains(rawBody) ? rawBody : "cursor")
    return OmbBotVisual(
      botId: botId,
      botName: name,
      roomName: nil,
      colorHex: color,
      gradientHex: [color, color, color],
      body: body,
      faceInkHex: defaultFaceInk(for: color),
      mood: "unread"
    )
  }

  private static func assetBundles() -> [Bundle] {
    var bundles: [Bundle] = []
    if let mascotURL = Bundle.main.url(forResource: "OmbMascotAssets", withExtension: "bundle"),
       let b = Bundle(url: mascotURL) {
      bundles.append(b)
    }
    bundles.append(Bundle.main)
    if let pluginsURL = Bundle.main.builtInPlugInsURL {
      let widgetsURL = pluginsURL.appendingPathComponent("ExpoWidgetsTarget.appex")
      if let b = Bundle(url: widgetsURL) {
        bundles.append(b)
      }
    }
    return bundles
  }

  private static func loadMascotAsset(named name: String) -> UIImage? {
    for bundle in assetBundles() {
      if let img = UIImage(named: name, in: bundle, compatibleWith: nil) {
        return img
      }
    }
    return nil
  }

  public static func renderAvatarPng(for visual: OmbBotVisual) -> Data? {
    let canvasSize = CGSize(width: 240, height: 240)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1.0
    format.opaque = false

    let mainColor = uiColor(hex: visual.colorHex) ?? UIColor(red: 0.06, green: 0.73, blue: 0.51, alpha: 1.0)
    let faceColor = uiColor(hex: visual.faceInkHex) ?? .white
    let bgColor = mixedBackdropColor(accent: mainColor)

    let image = UIGraphicsImageRenderer(size: canvasSize, format: format).image { rendererCtx in
      let ctx = rendererCtx.cgContext
      let fullRect = CGRect(origin: .zero, size: canvasSize)

      ctx.saveGState()
      ctx.setFillColor(bgColor.cgColor)
      ctx.fillEllipse(in: fullRect)
      ctx.restoreGState()

      let inset: CGFloat = 26
      let mascotRect = fullRect.insetBy(dx: inset, dy: inset)

      if visual.body.isEmpty {
        if let groupSymbol = UIImage(systemName: "person.2.fill")?.withTintColor(.white, renderingMode: .alwaysOriginal) {
          ctx.saveGState()
          ctx.setFillColor(mainColor.cgColor)
          ctx.fillEllipse(in: fullRect.insetBy(dx: 16, dy: 16))
          ctx.restoreGState()
          let symRect = fullRect.insetBy(dx: 58, dy: 68)
          groupSymbol.draw(in: symRect)
          return
        }
      }

      let bodyAssetName = "mascot-body-\(visual.body.isEmpty ? "cursor" : visual.body)"
      let faceAssetName = "mascot-face-\(visual.body.isEmpty ? "cursor" : visual.body)-\(visual.mood)"
      let fallbackFaceName = "mascot-face-\(visual.body.isEmpty ? "cursor" : visual.body)-idle"

      if let bodyImg = loadMascotAsset(named: bodyAssetName) {
        drawGradientMaskedImage(
          ctx: ctx,
          image: bodyImg,
          rect: mascotRect,
          gradientHex: visual.gradientHex,
          fallbackColor: mainColor
        )
        if let faceImg = loadMascotAsset(named: faceAssetName) ?? loadMascotAsset(named: fallbackFaceName) {
          faceImg.withTintColor(faceColor, renderingMode: .alwaysOriginal).draw(in: mascotRect)
        }
      } else {
        let pillPath = UIBezierPath(roundedRect: mascotRect.insetBy(dx: 10, dy: 10), cornerRadius: 48)
        mainColor.setFill()
        pillPath.fill()
        faceColor.setFill()
        UIBezierPath(roundedRect: CGRect(x: 84, y: 98, width: 22, height: 42), cornerRadius: 11).fill()
        UIBezierPath(roundedRect: CGRect(x: 134, y: 98, width: 22, height: 42), cornerRadius: 11).fill()
      }
    }
    return image.pngData()
  }

  private static func drawGradientMaskedImage(
    ctx: CGContext,
    image: UIImage,
    rect: CGRect,
    gradientHex: [String],
    fallbackColor: UIColor
  ) {
    ctx.saveGState()
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    image.draw(in: rect)
    ctx.setBlendMode(.sourceIn)
    if gradientHex.count >= 3,
       let c0 = uiColor(hex: gradientHex[0])?.cgColor,
       let c1 = uiColor(hex: gradientHex[1])?.cgColor,
       let c2 = uiColor(hex: gradientHex[2])?.cgColor,
       let gradient = CGGradient(
         colorsSpace: CGColorSpaceCreateDeviceRGB(),
         colors: [c0, c1, c2] as CFArray,
         locations: [0.0, 0.55, 1.0]
       ) {
      ctx.drawLinearGradient(
        gradient,
        start: CGPoint(x: rect.maxX, y: rect.minY),
        end: CGPoint(x: rect.minX, y: rect.maxY),
        options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
      )
    } else {
      ctx.setFillColor(fallbackColor.cgColor)
      ctx.fill(rect)
    }
    ctx.endTransparencyLayer()
    ctx.restoreGState()
  }

  private static func mixedBackdropColor(accent: UIColor) -> UIColor {
    var ar: CGFloat = 0, ag: CGFloat = 0, ab: CGFloat = 0, aa: CGFloat = 1
    accent.getRed(&ar, green: &ag, blue: &ab, alpha: &aa)
    let br: CGFloat = 0x16 / 255.0
    let bg: CGFloat = 0x18 / 255.0
    let bb: CGFloat = 0x1D / 255.0
    let w: CGFloat = 0.20
    return UIColor(
      red: br + (ar - br) * w,
      green: bg + (ag - bg) * w,
      blue: bb + (ab - bb) * w,
      alpha: 1.0
    )
  }

  private static func defaultFaceInk(for colorHex: String) -> String {
    let upper = colorHex.uppercased()
    if upper == "#788B9D" || upper == "#CBD5E1" || upper == "#E2E8F0" {
      return "#1E2833"
    }
    return "#FFFFFF"
  }

  private static func trimmed(_ value: String?) -> String? {
    guard let s = value?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else {
      return nil
    }
    return s
  }

  private static func sanitizedHex(_ raw: String?) -> String? {
    guard let s = trimmed(raw) else { return nil }
    let hex = s.hasPrefix("#") ? String(s.dropFirst()) : s
    guard hex.count == 6, Int(hex, radix: 16) != nil else { return nil }
    return "#\(hex.uppercased())"
  }

  private static func uiColor(hex: String) -> UIColor? {
    let clean = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    guard clean.count == 6, let rgb = UInt32(clean, radix: 16) else { return nil }
    return UIColor(
      red: CGFloat((rgb >> 16) & 0xFF) / 255.0,
      green: CGFloat((rgb >> 8) & 0xFF) / 255.0,
      blue: CGFloat(rgb & 0xFF) / 255.0,
      alpha: 1.0
    )
  }
}
