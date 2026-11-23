import Foundation
import UserNotifications

@objc(NotificationService)
public final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttemptContent: UNMutableNotificationContent?

  public override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    self.bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)

    OmbNotificationUpgrader.upgrade(content: request.content) { upgraded in
      contentHandler(upgraded)
    }
  }

  public override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let bestAttemptContent {
      contentHandler(bestAttemptContent)
    }
  }
}
