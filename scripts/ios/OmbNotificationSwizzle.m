#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#import <objc/runtime.h>

@interface OmbNotificationLocalBridge : NSObject
+ (void)upgradeRequest:(UNNotificationRequest *)request
            completion:(void (^)(UNNotificationRequest *upgraded))completion;
@end

typedef void (*OmbAddRequestFn)(id, SEL, UNNotificationRequest *, void (^)(NSError * _Nullable));
static OmbAddRequestFn gOrigAddRequest = NULL;

static void omb_swizzled_addNotificationRequest(
  id self,
  SEL _cmd,
  UNNotificationRequest *request,
  void (^completionHandler)(NSError * _Nullable)
) {
  if (!request || [request.content.userInfo[@"ombUpgraded"] boolValue]) {
    gOrigAddRequest(self, _cmd, request, completionHandler);
    return;
  }
  Class bridgeClass = objc_getClass("OmbNotificationLocalBridge");
  if (!bridgeClass) {
    gOrigAddRequest(self, _cmd, request, completionHandler);
    return;
  }
  [bridgeClass upgradeRequest:request completion:^(UNNotificationRequest *upgraded) {
    gOrigAddRequest(self, _cmd, upgraded ?: request, completionHandler);
  }];
}

__attribute__((constructor))
static void omb_install_notification_avatar_hook(void) {
  Class cls = [UNUserNotificationCenter class];
  if (!cls) return;
  SEL sel = @selector(addNotificationRequest:withCompletionHandler:);
  Method m = class_getInstanceMethod(cls, sel);
  if (!m) return;
  gOrigAddRequest = (OmbAddRequestFn)method_setImplementation(m, (IMP)omb_swizzled_addNotificationRequest);
}
