#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <os/lock.h>

@interface OmbNotificationLocalBridge : NSObject
+ (void)upgradeRequest:(UNNotificationRequest *)request
            completion:(void (^)(UNNotificationRequest *upgraded))completion;
@end

typedef void (*OmbAddRequestFn)(id, SEL, UNNotificationRequest *, void (^)(NSError * _Nullable));
typedef void (*OmbTaskResumeFn)(id, SEL);
typedef void (*OmbDidInitRuntimeFn)(id, SEL, id, void *);

static OmbAddRequestFn gOrigAddRequest = NULL;
static OmbTaskResumeFn gOrigTaskResume = NULL;
static OmbDidInitRuntimeFn gOrigDidInitRuntime = NULL;

static os_unfair_lock gStateLock = OS_UNFAIR_LOCK_INIT;
static BOOL gAppStateKnown = NO;
static BOOL gInBackground = NO;
static BOOL gRctHostHooked = NO;
static NSHashTable<NSURLSessionTask *> *gActiveSseTasks = nil;
static NSString *gCapturedApiBase = nil;
static NSString *gCapturedAuthHeader = nil;
static NSString *gCapturedCookieHeader = nil;
static NSMutableDictionary<NSString *, NSString *> *gPendingActivityTokens = nil;
static NSURLSession *gInternalSession = nil;
static UIBackgroundTaskIdentifier gActivityBgTask = 0;
static NSUInteger gInFlightTokenPosts = 0;

static void omb_end_activity_bg_task_locked(void) {
  if (gActivityBgTask == UIBackgroundTaskInvalid) return;
  UIBackgroundTaskIdentifier taskId = gActivityBgTask;
  gActivityBgTask = UIBackgroundTaskInvalid;
  dispatch_async(dispatch_get_main_queue(), ^{
    [[UIApplication sharedApplication] endBackgroundTask:taskId];
  });
}

static void omb_hold_activity_bg_task(NSTimeInterval seconds) {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIApplication *app = [UIApplication sharedApplication];
    if (!app) return;
    __block UIBackgroundTaskIdentifier newTask = UIBackgroundTaskInvalid;
    newTask = [app beginBackgroundTaskWithName:@"omb.activityToken" expirationHandler:^{
      os_unfair_lock_lock(&gStateLock);
      if (gActivityBgTask == newTask) {
        gActivityBgTask = UIBackgroundTaskInvalid;
      }
      os_unfair_lock_unlock(&gStateLock);
      if (newTask != UIBackgroundTaskInvalid) {
        [app endBackgroundTask:newTask];
      }
    }];
    if (newTask == UIBackgroundTaskInvalid) return;

    UIBackgroundTaskIdentifier prevTask = UIBackgroundTaskInvalid;
    os_unfair_lock_lock(&gStateLock);
    prevTask = gActivityBgTask;
    gActivityBgTask = newTask;
    os_unfair_lock_unlock(&gStateLock);
    if (prevTask != UIBackgroundTaskInvalid) {
      [app endBackgroundTask:prevTask];
    }

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      BOOL shouldEnd = NO;
      os_unfair_lock_lock(&gStateLock);
      if (gActivityBgTask == newTask && gInFlightTokenPosts == 0) {
        gActivityBgTask = UIBackgroundTaskInvalid;
        shouldEnd = YES;
      }
      os_unfair_lock_unlock(&gStateLock);
      if (shouldEnd) {
        [app endBackgroundTask:newTask];
      }
    });
  });
}

static NSURLSession *omb_shared_internal_session(void) {
  os_unfair_lock_lock(&gStateLock);
  NSURLSession *session = gInternalSession;
  if (!session) {
    NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    cfg.timeoutIntervalForRequest = 6.0;
    cfg.timeoutIntervalForResource = 8.0;
    cfg.waitsForConnectivity = NO;
    session = [NSURLSession sessionWithConfiguration:cfg];
    gInternalSession = session;
  }
  os_unfair_lock_unlock(&gStateLock);
  return session;
}

static void omb_send_activity_token_post(
  NSString *apiBase,
  NSString * _Nullable authHeader,
  NSString * _Nullable cookieHeader,
  NSString *token,
  NSString * _Nullable activityId
) {
  NSURL *url = [NSURL URLWithString:[apiBase stringByAppendingString:@"/api/push/activity"]];
  if (!url) return;

  NSMutableDictionary<NSString *, NSString *> *payload = [NSMutableDictionary dictionaryWithCapacity:2];
  payload[@"token"] = token;
  if (activityId.length > 0) {
    payload[@"activityId"] = activityId;
  }
  NSError *jsonErr = nil;
  NSData *body = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&jsonErr];
  if (!body || jsonErr) return;

  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
  req.HTTPMethod = @"POST";
  req.HTTPBody = body;
  [req setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  [req setValue:@"1" forHTTPHeaderField:@"X-OMB-Internal-Bridge"];
  if (authHeader.length > 0) {
    [req setValue:authHeader forHTTPHeaderField:@"Authorization"];
  }
  if (cookieHeader.length > 0) {
    [req setValue:cookieHeader forHTTPHeaderField:@"Cookie"];
  }

  os_unfair_lock_lock(&gStateLock);
  gInFlightTokenPosts += 1;
  os_unfair_lock_unlock(&gStateLock);

  NSURLSessionDataTask *task = [omb_shared_internal_session()
    dataTaskWithRequest:req
      completionHandler:^(__unused NSData * _Nullable data, NSURLResponse * _Nullable response, NSError * _Nullable error) {
        NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]]
          ? ((NSHTTPURLResponse *)response).statusCode
          : 0;
        os_unfair_lock_lock(&gStateLock);
        if ((error != nil || status >= 500) && gPendingActivityTokens.count < 10) {
          gPendingActivityTokens[token] = activityId ?: @"";
        }
        if (gInFlightTokenPosts > 0) {
          gInFlightTokenPosts -= 1;
        }
        if (gInFlightTokenPosts == 0 && gPendingActivityTokens.count == 0) {
          omb_end_activity_bg_task_locked();
        }
        os_unfair_lock_unlock(&gStateLock);
      }];
  [task resume];
}

static void omb_flush_pending_tokens(void) {
  NSString *apiBase = nil;
  NSString *auth = nil;
  NSString *cookie = nil;
  NSDictionary<NSString *, NSString *> *snapshot = nil;

  os_unfair_lock_lock(&gStateLock);
  if (gCapturedApiBase.length > 0 && (gCapturedAuthHeader.length > 0 || gCapturedCookieHeader.length > 0) && gPendingActivityTokens.count > 0) {
    apiBase = [gCapturedApiBase copy];
    auth = [gCapturedAuthHeader copy];
    cookie = [gCapturedCookieHeader copy];
    snapshot = [gPendingActivityTokens copy];
    [gPendingActivityTokens removeAllObjects];
  }
  os_unfair_lock_unlock(&gStateLock);

  if (!snapshot.count) return;
  [snapshot enumerateKeysAndObjectsUsingBlock:^(NSString *token, NSString *activityId, __unused BOOL *stop) {
    omb_send_activity_token_post(apiBase, auth, cookie, token, activityId);
  }];
}

static void omb_queue_or_send_activity_token(NSString *token, NSString * _Nullable activityId) {
  if (token.length < 32 || token.length > 512) return;
  os_unfair_lock_lock(&gStateLock);
  if (!gPendingActivityTokens) {
    gPendingActivityTokens = [NSMutableDictionary dictionary];
  }
  gPendingActivityTokens[token.lowercaseString] = activityId ?: @"";
  os_unfair_lock_unlock(&gStateLock);
  omb_flush_pending_tokens();
}

static void omb_capture_api_credentials(NSURL *url, NSURLRequest *req) {
  NSString *abs = url.absoluteString;
  NSRange apiRange = [abs rangeOfString:@"/api/"];
  if (apiRange.location == NSNotFound || apiRange.location == 0) return;
  NSString *base = [abs substringToIndex:apiRange.location];
  NSString *auth = [req valueForHTTPHeaderField:@"Authorization"];
  NSString *cookie = [req valueForHTTPHeaderField:@"Cookie"];
  if (auth.length == 0 && cookie.length == 0) return;

  BOOL shouldFlush = NO;
  os_unfair_lock_lock(&gStateLock);
  gCapturedApiBase = [base copy];
  if (auth.length > 0) {
    gCapturedAuthHeader = [auth copy];
  }
  if (cookie.length > 0) {
    gCapturedCookieHeader = [cookie copy];
  }
  shouldFlush = gPendingActivityTokens.count > 0;
  os_unfair_lock_unlock(&gStateLock);

  if (shouldFlush) {
    omb_flush_pending_tokens();
  }
}

static NSArray<NSURLSessionTask *> *omb_set_background_and_take_sse_tasks(BOOL inBackground) {
  NSArray<NSURLSessionTask *> *tasks = nil;
  os_unfair_lock_lock(&gStateLock);
  gAppStateKnown = YES;
  gInBackground = inBackground;
  if (inBackground && gActiveSseTasks.count > 0) {
    tasks = [gActiveSseTasks allObjects];
    [gActiveSseTasks removeAllObjects];
  }
  os_unfair_lock_unlock(&gStateLock);
  return tasks;
}

static void omb_cancel_sse_tasks_with_bg_grace(NSArray<NSURLSessionTask *> * _Nullable tasks) {
  if (!tasks.count) return;
  UIApplication *app = [UIApplication sharedApplication];
  __block UIBackgroundTaskIdentifier bgId = UIBackgroundTaskInvalid;
  if (app) {
    bgId = [app beginBackgroundTaskWithName:@"omb.closeSSE" expirationHandler:^{
      if (bgId != UIBackgroundTaskInvalid) {
        UIBackgroundTaskIdentifier expired = bgId;
        bgId = UIBackgroundTaskInvalid;
        [app endBackgroundTask:expired];
      }
    }];
  }
  for (NSURLSessionTask *task in tasks) {
    [task cancel];
  }
  if (bgId != UIBackgroundTaskInvalid) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      if (bgId != UIBackgroundTaskInvalid) {
        UIBackgroundTaskIdentifier finished = bgId;
        bgId = UIBackgroundTaskInvalid;
        [app endBackgroundTask:finished];
      }
    });
  }
}

static BOOL omb_is_currently_in_background(void) {
  BOOL known = NO;
  BOOL inBg = NO;
  os_unfair_lock_lock(&gStateLock);
  known = gAppStateKnown;
  inBg = gInBackground;
  os_unfair_lock_unlock(&gStateLock);

  if (!known && [NSThread isMainThread]) {
    UIApplication *app = [UIApplication sharedApplication];
    if (app) {
      inBg = (app.applicationState == UIApplicationStateBackground);
      os_unfair_lock_lock(&gStateLock);
      gAppStateKnown = YES;
      gInBackground = inBg;
      os_unfair_lock_unlock(&gStateLock);
    }
  }
  return inBg;
}

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

static void omb_swizzled_task_resume(id self, SEL _cmd) {
  if (![self isKindOfClass:[NSURLSessionTask class]]) {
    gOrigTaskResume(self, _cmd);
    return;
  }
  NSURLSessionTask *task = (NSURLSessionTask *)self;
  NSURLRequest *req = task.currentRequest ?: task.originalRequest;
  if (!req || [req valueForHTTPHeaderField:@"X-OMB-Internal-Bridge"] != nil) {
    gOrigTaskResume(self, _cmd);
    return;
  }

  NSURL *url = req.URL;
  NSString *host = url.host.lowercaseString;
  if ([host isEqualToString:@"omb-runtime-bridge.invalid"]) {
    NSURLComponents *components = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
    NSString *actId = nil;
    NSString *token = nil;
    for (NSURLQueryItem *item in components.queryItems) {
      if ([item.name isEqualToString:@"id"]) actId = item.value;
      else if ([item.name isEqualToString:@"token"]) token = item.value;
    }
    if ([url.path isEqualToString:@"/activity-wake"]) {
      omb_hold_activity_bg_task(8.0);
    } else if ([url.path isEqualToString:@"/activity-token"] && token.length > 0) {
      omb_hold_activity_bg_task(8.0);
      omb_queue_or_send_activity_token(token, actId);
    }
    [task cancel];
    return;
  }

  NSString *path = url.path;
  if (path.length > 0 && [path containsString:@"/api/"] && ![host isEqualToString:@"accounts.openmausbot.com"]) {
    omb_capture_api_credentials(url, req);
    if ([path hasSuffix:@"/api/events"]) {
      if (omb_is_currently_in_background()) {
        [task cancel];
        return;
      }
      os_unfair_lock_lock(&gStateLock);
      if (!gActiveSseTasks) {
        gActiveSseTasks = [NSHashTable weakObjectsHashTable];
      }
      [gActiveSseTasks addObject:task];
      os_unfair_lock_unlock(&gStateLock);
    }
  }

  gOrigTaskResume(self, _cmd);
}

static void omb_register_runtime_patch_segment(id instance, NSUInteger segId, NSString *patchPath) {
  if (!instance || patchPath.length == 0) return;
  SEL regSel = NSSelectorFromString(@"registerSegmentWithId:path:");
  if (![instance respondsToSelector:regSel]) return;
  NSMethodSignature *sig = [instance methodSignatureForSelector:regSel];
  if (!sig || sig.numberOfArguments < 4) return;
  const char *argType = [sig getArgumentTypeAtIndex:2];
  if (argType && argType[0] == '@') {
    ((void (*)(id, SEL, id, id))objc_msgSend)(instance, regSel, @(segId), patchPath);
  } else {
    ((void (*)(id, SEL, NSUInteger, id))objc_msgSend)(instance, regSel, segId, patchPath);
  }
}

static void omb_swizzled_didInitializeRuntime(id self, SEL _cmd, id instance, void *runtime) {
  gOrigDidInitRuntime(self, _cmd, instance, runtime);
  NSString *patchPath = [[NSBundle mainBundle] pathForResource:@"OmbRuntimePatch" ofType:@"js"];
  if (patchPath.length == 0 || ![[NSFileManager defaultManager] fileExistsAtPath:patchPath]) {
    return;
  }
  omb_register_runtime_patch_segment(instance, 777001, patchPath);
  __weak id weakInstance = instance;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    omb_register_runtime_patch_segment(weakInstance, 777002, patchPath);
  });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    omb_register_runtime_patch_segment(weakInstance, 777003, patchPath);
  });
}

static void omb_install_rct_host_hook(void) {
  os_unfair_lock_lock(&gStateLock);
  if (gRctHostHooked) {
    os_unfair_lock_unlock(&gStateLock);
    return;
  }
  Class hostCls = objc_getClass("RCTHost");
  SEL sel = NSSelectorFromString(@"instance:didInitializeRuntime:");
  Method m = hostCls ? class_getInstanceMethod(hostCls, sel) : NULL;
  if (m) {
    gOrigDidInitRuntime = (OmbDidInitRuntimeFn)method_setImplementation(m, (IMP)omb_swizzled_didInitializeRuntime);
    gRctHostHooked = YES;
  }
  os_unfair_lock_unlock(&gStateLock);
}

static void omb_install_urlsession_hook(void) {
  NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration ephemeralSessionConfiguration];
  NSURLSession *probeSession = [NSURLSession sessionWithConfiguration:cfg];
  NSURL *probeUrl = [NSURL URLWithString:@"https://omb-probe.invalid/"];
  if (!probeSession || !probeUrl) return;
  NSURLSessionDataTask *probeTask = [probeSession dataTaskWithURL:probeUrl];
  Class taskCls = probeTask ? [probeTask superclass] : Nil;
  [probeTask cancel];
  [probeSession finishTasksAndInvalidate];
  if (!taskCls) return;
  SEL resumeSel = @selector(resume);
  Method m = class_getInstanceMethod(taskCls, resumeSel);
  if (!m) return;
  gOrigTaskResume = (OmbTaskResumeFn)method_setImplementation(m, (IMP)omb_swizzled_task_resume);
}

static void omb_install_app_lifecycle_observers(void) {
  NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
  [nc addObserverForName:UIApplicationDidFinishLaunchingNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *note) {
                omb_install_rct_host_hook();
                UIApplication *app = [note.object isKindOfClass:[UIApplication class]]
                  ? (UIApplication *)note.object
                  : [UIApplication sharedApplication];
                BOOL isBg = app && (app.applicationState == UIApplicationStateBackground);
                NSArray<NSURLSessionTask *> *tasks = omb_set_background_and_take_sse_tasks(isBg);
                omb_cancel_sse_tasks_with_bg_grace(tasks);
              }];

  [nc addObserverForName:UIApplicationDidEnterBackgroundNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *note) {
                NSArray<NSURLSessionTask *> *tasks = omb_set_background_and_take_sse_tasks(YES);
                omb_cancel_sse_tasks_with_bg_grace(tasks);
              }];

  [nc addObserverForName:UIApplicationWillEnterForegroundNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *note) {
                (void)omb_set_background_and_take_sse_tasks(NO);
              }];

  [nc addObserverForName:UIApplicationDidBecomeActiveNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *note) {
                (void)omb_set_background_and_take_sse_tasks(NO);
              }];

  dispatch_async(dispatch_get_main_queue(), ^{
    omb_install_rct_host_hook();
    UIApplication *app = [UIApplication sharedApplication];
    if (!app) return;
    BOOL isBg = (app.applicationState == UIApplicationStateBackground);
    NSArray<NSURLSessionTask *> *tasks = omb_set_background_and_take_sse_tasks(isBg);
    omb_cancel_sse_tasks_with_bg_grace(tasks);
  });
}

__attribute__((constructor))
static void omb_install_notification_avatar_hook(void) {
  gActivityBgTask = UIBackgroundTaskInvalid;
  Class cls = [UNUserNotificationCenter class];
  if (cls) {
    SEL sel = @selector(addNotificationRequest:withCompletionHandler:);
    Method m = class_getInstanceMethod(cls, sel);
    if (m) {
      gOrigAddRequest = (OmbAddRequestFn)method_setImplementation(m, (IMP)omb_swizzled_addNotificationRequest);
    }
  }
  omb_install_urlsession_hook();
  omb_install_rct_host_hook();
  omb_install_app_lifecycle_observers();
}
