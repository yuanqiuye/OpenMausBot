import Foundation
import UserNotifications

@objc(OmbNotificationLocalBridge)
public final class OmbNotificationLocalBridge: NSObject {
  @objc
  public static func upgradeRequest(
    _ request: UNNotificationRequest,
    completion: @escaping (UNNotificationRequest) -> Void
  ) {
    if (request.content.userInfo["ombUpgraded"] as? Bool) == true {
      completion(request)
      return
    }
    if request.trigger is UNPushNotificationTrigger {
      completion(request)
      return
    }
    OmbNotificationUpgrader.upgrade(content: request.content) { upgradedContent in
      let upgradedRequest = UNNotificationRequest(
        identifier: request.identifier,
        content: upgradedContent,
        trigger: request.trigger
      )
      completion(upgradedRequest)
    }
  }
}
