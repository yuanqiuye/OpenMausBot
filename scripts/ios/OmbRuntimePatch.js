(function () {
  "use strict";

  var g = typeof globalThis !== "undefined" ? globalThis : typeof global !== "undefined" ? global : this;
  if (!g) return;

  var state = g.__ombLiveActivityGuard;
  if (!state) {
    state = {
      appState: "unknown",
      activeSinceMs: 0,
      factoryPatched: false,
      appStateBound: false,
      scannerStarted: false,
      protoPatched: false,
      localStartedIds: new Set(),
      reportedIds: new Set(),
      reportingIds: new Set(),
      tokenListeners: new Set(),
      deferredEnds: new Map(),
      flushDeferredEnds: function () {
        if (!state.deferredEnds.size) return;
        var entries = Array.from(state.deferredEnds.values());
        state.deferredEnds.clear();
        for (var i = 0; i < entries.length; i += 1) {
          try {
            entries[i].flush();
          } catch {}
        }
      },
    };
    try {
      Object.defineProperty(g, "__ombLiveActivityGuard", {
        value: state,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    } catch {
      g.__ombLiveActivityGuard = state;
    }
  }

  function setKnownAppState(next) {
    if (typeof next !== "string" || !next) return;
    if (next === "active" && state.appState !== "active") {
      state.activeSinceMs = Date.now();
    } else if (next !== "active" && state.deferredEnds.size) {
      var entries = Array.from(state.deferredEnds.values());
      state.deferredEnds.clear();
      for (var i = 0; i < entries.length; i += 1) {
        try {
          entries[i].cancel();
        } catch {}
      }
    }
    state.appState = next;
  }

  function getAppStateTurboModule() {
    try {
      if (typeof g.__turboModuleProxy === "function") {
        return g.__turboModuleProxy("AppState");
      }
    } catch {}
    return null;
  }

  function refreshAppState(callback) {
    var tm = getAppStateTurboModule();
    if (tm && typeof tm.getCurrentAppState === "function") {
      var done = false;
      var finish = function (resolved) {
        if (done) return;
        done = true;
        if (resolved) setKnownAppState(resolved);
        if (callback) callback(state.appState);
      };
      try {
        if (typeof g.setTimeout === "function") {
          g.setTimeout(function () {
            finish(null);
          }, 150);
        }
        tm.getCurrentAppState(
          function (res) {
            var current = res && typeof res.app_state === "string" ? res.app_state : null;
            finish(current);
          },
          function () {
            finish(null);
          }
        );
        return;
      } catch {}
    }
    if (callback) callback(state.appState);
  }

  function bindInitialAppState() {
    if (state.appStateBound) return;
    var tm = getAppStateTurboModule();
    if (!tm) return;
    state.appStateBound = true;
    try {
      if (typeof tm.getConstants === "function") {
        var constants = tm.getConstants();
        if (constants && typeof constants.initialAppState === "string") {
          setKnownAppState(constants.initialAppState);
        }
      }
    } catch {}
    refreshAppState(null);
  }

  function sendBridgeSignal(pathWithQuery) {
    try {
      if (typeof g.fetch !== "function") return;
      var p = g.fetch("https://omb-runtime-bridge.invalid" + pathWithQuery, { method: "GET" });
      if (p && typeof p.catch === "function") {
        p.catch(function () {});
      }
    } catch {}
  }

  function normalizeHexToken(raw) {
    if (typeof raw !== "string") return "";
    var trimmed = raw.trim().toLowerCase();
    return /^[0-9a-f]{32,512}$/.test(trimmed) ? trimmed : "";
  }

  function reportPushStartedToken(id, rawToken) {
    var token = normalizeHexToken(rawToken);
    if (!id || !token || state.reportedIds.has(id)) return;
    state.reportedIds.add(id);
    state.reportingIds.delete(id);
    sendBridgeSignal(
      "/activity-token?id=" + encodeURIComponent(id) + "&token=" + encodeURIComponent(token)
    );
  }

  function observePushStartedInstance(inst) {
    if (!inst || (typeof inst !== "object" && typeof inst !== "function")) return;
    var id = "";
    try {
      id = typeof inst.id === "string" ? inst.id : "";
    } catch {}
    if (!id || state.localStartedIds.has(id) || state.reportedIds.has(id)) return;

    if (!state.reportingIds.has(id)) {
      state.reportingIds.add(id);
      sendBridgeSignal("/activity-wake?id=" + encodeURIComponent(id));
    }

    try {
      if (typeof inst.getPushToken === "function") {
        Promise.resolve(inst.getPushToken())
          .then(function (tok) {
            if (tok) reportPushStartedToken(id, tok);
          })
          .catch(function () {});
      }
    } catch {}

    if (!state.tokenListeners.has(id)) {
      try {
        if (typeof inst.addListener === "function") {
          state.tokenListeners.add(id);
          var sub = inst.addListener("onExpoWidgetsTokenReceived", function (event) {
            var tok =
              typeof event === "string"
                ? event
                : event && typeof event.pushToken === "string"
                  ? event.pushToken
                  : "";
            if (tok) {
              reportPushStartedToken(id, tok);
              try {
                if (sub && typeof sub.remove === "function") sub.remove();
              } catch {}
            }
          });
        }
      } catch {}
    }
  }

  function makeGuardedEnd(origEnd) {
    return function () {
      var self = this;
      var args = Array.prototype.slice.call(arguments);
      var id = "";
      try {
        id = self && typeof self.id === "string" ? self.id : "";
      } catch {}

      return new Promise(function (resolve) {
        refreshAppState(function (currentAppState) {
          if (currentAppState !== "active") {
            resolve(undefined);
            return;
          }

          var policy = args[0];
          var isImmediate = policy === "immediate" || policy === undefined;
          var recentlyActivated = Date.now() - state.activeSinceMs < 2500;
          if (
            isImmediate &&
            recentlyActivated &&
            id &&
            !state.localStartedIds.has(id) &&
            typeof g.setTimeout === "function"
          ) {
            var existing = state.deferredEnds.get(id);
            if (existing) existing.cancel();
            var settled = false;
            var timer = g.setTimeout(function () {
              if (settled) return;
              settled = true;
              state.deferredEnds.delete(id);
              refreshAppState(function (laterState) {
                if (laterState !== "active") {
                  resolve(undefined);
                  return;
                }
                try {
                  Promise.resolve(origEnd.apply(self, args)).then(resolve, function () {
                    resolve(undefined);
                  });
                } catch {
                  resolve(undefined);
                }
              });
            }, 1800);

            state.deferredEnds.set(id, {
              cancel: function () {
                if (settled) return;
                settled = true;
                if (typeof g.clearTimeout === "function") g.clearTimeout(timer);
                state.deferredEnds.delete(id);
                resolve(undefined);
              },
              flush: function () {
                if (settled) return;
                settled = true;
                if (typeof g.clearTimeout === "function") g.clearTimeout(timer);
                state.deferredEnds.delete(id);
                try {
                  Promise.resolve(origEnd.apply(self, args)).then(resolve, function () {
                    resolve(undefined);
                  });
                } catch {
                  resolve(undefined);
                }
              },
            });
            return;
          }

          try {
            Promise.resolve(origEnd.apply(self, args)).then(resolve, function () {
              resolve(undefined);
            });
          } catch {
            resolve(undefined);
          }
        });
      });
    };
  }

  function wrapInstance(inst, isLocalStart) {
    if (!inst || (typeof inst !== "object" && typeof inst !== "function")) return inst;
    var id = "";
    try {
      id = typeof inst.id === "string" ? inst.id : "";
    } catch {}
    if (isLocalStart && id) {
      state.localStartedIds.add(id);
    }

    if (!state.protoPatched) {
      try {
        var proto = Object.getPrototypeOf(inst);
        if (proto && proto !== Object.prototype && typeof proto.end === "function" && !proto.end.__ombGuarded) {
          var guardedProtoEnd = makeGuardedEnd(proto.end);
          guardedProtoEnd.__ombGuarded = true;
          Object.defineProperty(proto, "end", {
            value: guardedProtoEnd,
            configurable: true,
            writable: true,
          });
          state.protoPatched = true;
        }
      } catch {}
    }

    try {
      if (Object.prototype.hasOwnProperty.call(inst, "end") && typeof inst.end === "function" && !inst.end.__ombGuarded) {
        var guardedOwnEnd = makeGuardedEnd(inst.end);
        guardedOwnEnd.__ombGuarded = true;
        Object.defineProperty(inst, "end", {
          value: guardedOwnEnd,
          configurable: true,
          writable: true,
        });
      } else if (!state.protoPatched && typeof inst.end === "function" && !inst.end.__ombGuarded) {
        var guardedFallbackEnd = makeGuardedEnd(inst.end);
        guardedFallbackEnd.__ombGuarded = true;
        Object.defineProperty(inst, "end", {
          value: guardedFallbackEnd,
          configurable: true,
          writable: true,
        });
      }
    } catch {}

    if (!isLocalStart) {
      observePushStartedInstance(inst);
    }
    return inst;
  }

  function getExpoWidgets() {
    try {
      var expo = g.expo;
      var modules = expo && expo.modules;
      return modules ? modules.ExpoWidgets : null;
    } catch {
      return null;
    }
  }

  function patchLiveActivityFactory() {
    if (state.factoryPatched) return true;
    var expoWidgets = getExpoWidgets();
    var factory = expoWidgets && expoWidgets.LiveActivityFactory;
    if (!factory) return false;

    var origStart = typeof factory.start === "function" ? factory.start : null;
    var origGetInstances = typeof factory.getInstances === "function" ? factory.getInstances : null;
    if (!origStart || !origGetInstances) return false;

    var wrappedStart = function () {
      state.flushDeferredEnds();
      var res = origStart.apply(this, arguments);
      if (res && typeof res.then === "function") {
        return res.then(function (inst) {
          return wrapInstance(inst, true);
        });
      }
      return wrapInstance(res, true);
    };

    var wrappedGetInstances = function () {
      var list = origGetInstances.apply(this, arguments);
      if (Array.isArray(list)) {
        for (var i = 0; i < list.length; i += 1) {
          wrapInstance(list[i], false);
        }
      }
      return list;
    };

    var replaced = false;
    try {
      Object.defineProperty(factory, "start", {
        value: wrappedStart,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(factory, "getInstances", {
        value: wrappedGetInstances,
        configurable: true,
        writable: true,
      });
      replaced = factory.start === wrappedStart && factory.getInstances === wrappedGetInstances;
    } catch {}

    if (!replaced && typeof Proxy === "function") {
      try {
        var proxyFactory = new Proxy(factory, {
          get: function (target, prop, receiver) {
            if (prop === "start") return wrappedStart.bind(target);
            if (prop === "getInstances") return wrappedGetInstances.bind(target);
            return Reflect.get(target, prop, receiver);
          },
        });
        Object.defineProperty(expoWidgets, "LiveActivityFactory", {
          value: proxyFactory,
          configurable: true,
          writable: true,
        });
        replaced = expoWidgets.LiveActivityFactory === proxyFactory;
      } catch {}
    }

    if (replaced) {
      state.factoryPatched = true;
      state.scanInstances = function () {
        try {
          var currentFactory = getExpoWidgets() && getExpoWidgets().LiveActivityFactory;
          if (currentFactory && typeof currentFactory.getInstances === "function") {
            currentFactory.getInstances();
          }
        } catch {}
      };
    }
    return replaced;
  }

  function startBackgroundScanner() {
    if (state.scannerStarted) return;
    if (typeof g.setInterval !== "function" || typeof g.fetch !== "function") return;
    if (!state.factoryPatched) return;
    state.scannerStarted = true;
    state.scanInstances();
    g.setInterval(function () {
      refreshAppState(function (current) {
        if (current !== "active" && typeof state.scanInstances === "function") {
          state.scanInstances();
        }
      });
    }, 1200);
  }

  bindInitialAppState();
  patchLiveActivityFactory();
  startBackgroundScanner();

  if ((!state.factoryPatched || !state.scannerStarted) && typeof g.setTimeout === "function") {
    var attempts = 0;
    var retry = function () {
      attempts += 1;
      bindInitialAppState();
      patchLiveActivityFactory();
      startBackgroundScanner();
      if ((!state.factoryPatched || !state.scannerStarted) && attempts < 20) {
        g.setTimeout(retry, 150);
      }
    };
    g.setTimeout(retry, 100);
  }
})();
