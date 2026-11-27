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
      endedIds: new Set(),
      instanceBotIds: new Map(),
      activeBotTokens: new Map(),
      botInstanceIds: new Map(),
      reportedIds: new Set(),
      reportingIds: new Set(),
      tokenListeners: new Set(),
      deferredEnds: new Map(),
      screenPatch: null,
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
  if (!state.endedIds) state.endedIds = new Set();
  if (!state.activeBotTokens) state.activeBotTokens = new Map();
  if (!state.botInstanceIds) state.botInstanceIds = new Map();
  if (!state.factoryInstances) state.factoryInstances = new Set();

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

  function readNativeAppStateSync() {
    try {
      if (typeof g.__ombNativeBridge === "function") {
        var nativeState = g.__ombNativeBridge("/app-state", "");
        if (nativeState === "active" || nativeState === "inactive" || nativeState === "background") {
          setKnownAppState(nativeState);
          return nativeState;
        }
      }
    } catch {}
    return null;
  }

  function refreshAppState(callback) {
    var syncState = readNativeAppStateSync();
    if (syncState) {
      if (callback) callback(syncState);
      return;
    }
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
    var nativeSync = readNativeAppStateSync();
    var tm = getAppStateTurboModule();
    if (!tm && !nativeSync) return;
    state.appStateBound = true;
    try {
      if (tm && typeof tm.getConstants === "function") {
        var constants = tm.getConstants();
        if (constants && typeof constants.initialAppState === "string") {
          setKnownAppState(constants.initialAppState);
        }
      }
    } catch {}
    refreshAppState(null);
  }

  function sendBridgeWake(activityId, botId) {
    var payload = {};
    if (activityId) payload.id = activityId;
    if (botId) payload.botId = botId;
    try {
      if (typeof g.__ombNativeBridge === "function") {
        g.__ombNativeBridge("/activity-wake", JSON.stringify(payload));
        return;
      }
    } catch {}
    var qs = "";
    if (activityId) qs += (qs ? "&" : "?") + "id=" + encodeURIComponent(activityId);
    if (botId) qs += (qs ? "&" : "?") + "botId=" + encodeURIComponent(botId);
    sendBridgeSignal("/activity-wake" + qs);
  }

  function sendBridgeToken(activityId, botId, token) {
    var payload = { token: token };
    if (activityId) payload.id = activityId;
    if (botId) payload.botId = botId;
    try {
      if (typeof g.__ombNativeBridge === "function") {
        g.__ombNativeBridge("/activity-token", JSON.stringify(payload));
        return;
      }
    } catch {}
    var query =
      "/activity-token?id=" +
      encodeURIComponent(activityId || "") +
      (botId ? "&botId=" + encodeURIComponent(botId) : "") +
      "&token=" +
      encodeURIComponent(token);
    sendBridgeSignal(query);
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

  function sendBridgeJson(pathOnly, payload) {
    if (!payload || typeof payload !== "object") return;
    var serialized = "";
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return;
    }
    try {
      if (typeof g.__ombNativeBridge === "function") {
        g.__ombNativeBridge(pathOnly, serialized);
        return;
      }
    } catch {}
    try {
      if (typeof g.fetch !== "function") return;
      var p = g.fetch("https://omb-runtime-bridge.invalid" + pathOnly, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serialized,
      });
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

  function getInstanceId(inst) {
    if (!inst || (typeof inst !== "object" && typeof inst !== "function")) return "";
    try {
      if (typeof inst.id === "string" && inst.id) return inst.id;
      if (typeof inst.getId === "function") {
        var fromMethod = inst.getId();
        if (typeof fromMethod === "string" && fromMethod) return fromMethod;
      }
    } catch {}
    return "";
  }

  function extractBotIdFromText(text) {
    if (typeof text !== "string" || !text) return "";
    var trimmed = text.trim();
    if (trimmed.charAt(0) === "{") {
      try {
        var parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.botId === "string" && parsed.botId.trim()) {
          return parsed.botId.trim();
        }
      } catch {}
    }
    return "";
  }

  function extractBotIdFromStartArgs(args) {
    if (!args || !args.length) return "";
    for (var i = 0; i < args.length; i += 1) {
      var arg = args[i];
      if (typeof arg === "string") {
        var fromStr = extractBotIdFromText(arg);
        if (fromStr) return fromStr;
      } else if (arg && typeof arg === "object") {
        if (typeof arg.botId === "string" && arg.botId.trim()) return arg.botId.trim();
      }
    }
    return "";
  }

  function sanitizeActivityReg(reg, preserveBackgroundActiveTokens) {
    if (!reg || typeof reg !== "object") return reg;
    var patchState = state.screenPatch;
    var nextReg = Object.assign({}, reg);
    delete nextReg.startToken;
    if (
      patchState &&
      patchState.permissionGrantedThisSession &&
      Array.isArray(nextReg.kinds) &&
      nextReg.kinds.length === 0
    ) {
      nextReg.kinds = ["needsYou", "working"];
    }
    if (preserveBackgroundActiveTokens && state.activeBotTokens.size > 0) {
      var existing = Array.isArray(nextReg.activities) ? nextReg.activities.slice() : [];
      var hasBot = new Set();
      for (var i = 0; i < existing.length; i += 1) {
        var item = existing[i];
        if (item && typeof item.botId === "string" && item.botId) {
          hasBot.add(item.botId);
        }
      }
      state.activeBotTokens.forEach(function (tok, bId) {
        var trackedInstId = state.botInstanceIds.get(bId) || "";
        if (trackedInstId && state.endedIds.has(trackedInstId)) return;
        if (!hasBot.has(bId) && tok) {
          existing.push({ botId: bId, token: tok });
          hasBot.add(bId);
        }
      });
      if (existing.length > 10) {
        existing = existing.slice(existing.length - 10);
      }
      nextReg.activities = existing;
    }
    return nextReg;
  }

  function markInstanceEnded(id) {
    if (!id) return;
    state.endedIds.add(id);
    var botId = state.instanceBotIds.get(id) || "";
    if (botId && (!state.botInstanceIds.has(botId) || state.botInstanceIds.get(botId) === id)) {
      state.activeBotTokens.delete(botId);
      state.botInstanceIds.delete(botId);
    }
  }

  function syncActivityTokenViaClient(botId, token) {
    var patchState = state.screenPatch;
    if (!botId || !token || !patchState) return;
    var origRegAct = patchState.origRegisterActivity;
    var client = patchState.lastActivityClient;
    var lastReg = patchState.lastActivityReg;
    if (typeof origRegAct !== "function" || !client || !lastReg || typeof lastReg !== "object") return;

    var prevList = Array.isArray(lastReg.activities) ? lastReg.activities : [];
    var filtered = [];
    for (var i = 0; i < prevList.length; i += 1) {
      var item = prevList[i];
      if (!item || typeof item !== "object") continue;
      if (item.botId === botId || item.token === token) continue;
      filtered.push(item);
    }
    filtered.push({ botId: botId, token: token });
    if (filtered.length > 10) {
      filtered = filtered.slice(filtered.length - 10);
    }
    var nextReg = sanitizeActivityReg(
      Object.assign({}, lastReg, {
        activities: filtered,
      }),
      false
    );
    patchState.lastActivityReg = nextReg;
    sendBridgeJson("/activity-reg", nextReg);
    try {
      var res = origRegAct(client, nextReg);
      if (res && typeof res.catch === "function") {
        res.catch(function () {});
      }
    } catch {}
  }

  function reportActivityToken(id, rawToken) {
    var token = normalizeHexToken(rawToken);
    if (!id || !token || state.reportedIds.has(id) || state.endedIds.has(id)) return;
    state.reportedIds.add(id);
    state.reportingIds.delete(id);
    var botId = state.instanceBotIds.get(id) || "";
    if (botId) {
      state.activeBotTokens.set(botId, token);
      state.botInstanceIds.set(botId, id);
    }
    sendBridgeToken(id, botId, token);
    if (botId) {
      syncActivityTokenViaClient(botId, token);
    }
  }

  function observeActivityInstance(inst, botId) {
    var id = getInstanceId(inst);
    if (!id || state.endedIds.has(id)) return;
    if (botId && !state.instanceBotIds.has(id)) {
      state.instanceBotIds.set(id, botId);
    }
    if (state.reportedIds.has(id)) return;

    var resolvedBotId = state.instanceBotIds.get(id) || "";
    if (!state.reportingIds.has(id)) {
      state.reportingIds.add(id);
      sendBridgeWake(id, resolvedBotId);
    }

    try {
      if (typeof inst.getPushToken === "function") {
        Promise.resolve(inst.getPushToken())
          .then(function (tok) {
            if (tok) reportActivityToken(id, tok);
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
              reportActivityToken(id, tok);
              try {
                if (sub && typeof sub.remove === "function") sub.remove();
              } catch {}
            }
          });
        }
      } catch {}
    }
  }

  var MIN_COMPLETION_LINGER_MS = 30000;

  function buildEndCallArgs(rawArgs) {
    var callArgs = rawArgs.slice();
    if (callArgs[0] === "after") {
      var minAfterMs = Date.now() + MIN_COMPLETION_LINGER_MS;
      if (typeof callArgs[1] !== "number" || callArgs[1] < minAfterMs) {
        callArgs[1] = minAfterMs;
      }
    }
    return callArgs;
  }

  function makeGuardedEnd(origEnd) {
    return function () {
      var self = this;
      var args = Array.prototype.slice.call(arguments);
      var id = getInstanceId(self);
      var policy = args[0];
      var isCompletionWithProps =
        policy === "after" || (typeof args[2] === "string" && args[2].length > 0);

      if (isCompletionWithProps) {
        if (id) {
          var pending = state.deferredEnds.get(id);
          if (pending) pending.cancel();
          markInstanceEnded(id);
        }
        var completionArgs = buildEndCallArgs(args);
        return new Promise(function (resolve) {
          try {
            Promise.resolve(origEnd.apply(self, completionArgs)).then(resolve, function () {
              resolve(undefined);
            });
          } catch {
            resolve(undefined);
          }
        });
      }

      return new Promise(function (resolve) {
        refreshAppState(function (currentAppState) {
          if (currentAppState !== "active") {
            resolve(undefined);
            return;
          }

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
                markInstanceEnded(id);
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
                markInstanceEnded(id);
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

          markInstanceEnded(id);
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

  // ExpoWidgets >= 58.0.29 defines LiveActivity.getPushToken synchronously (`() throws -> String?`), whereas main.jsbundle calls `getPushToken().catch(...)`.
  function makeAsyncGetPushToken(origGetPushToken) {
    if (typeof origGetPushToken !== "function" || origGetPushToken.__ombAsyncWrapped) {
      return origGetPushToken;
    }
    var wrappedGetPushToken = function () {
      var self = this;
      var args = arguments;
      return new Promise(function (resolve) {
        try {
          Promise.resolve(origGetPushToken.apply(self, args)).then(
            function (tok) {
              var id = getInstanceId(self);
              if (id && tok) {
                reportActivityToken(id, tok);
              }
              resolve(tok == null ? null : tok);
            },
            function () {
              resolve(null);
            }
          );
        } catch {
          resolve(null);
        }
      });
    };
    wrappedGetPushToken.__ombAsyncWrapped = true;
    return wrappedGetPushToken;
  }

  function patchActivityPrototype(proto) {
    if (!proto || proto === Object.prototype) return;
    try {
      if (typeof proto.end === "function" && !proto.end.__ombGuarded) {
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
    try {
      if (typeof proto.getPushToken === "function" && !proto.getPushToken.__ombAsyncWrapped) {
        var asyncProtoPushToken = makeAsyncGetPushToken(proto.getPushToken);
        Object.defineProperty(proto, "getPushToken", {
          value: asyncProtoPushToken,
          configurable: true,
          writable: true,
        });
      }
    } catch {}
  }

  function wrapInstance(inst, isLocalStart, botId) {
    if (!inst || (typeof inst !== "object" && typeof inst !== "function")) return inst;
    var id = getInstanceId(inst);
    if (isLocalStart && id) {
      state.localStartedIds.add(id);
      state.endedIds.delete(id);
    }

    try {
      patchActivityPrototype(Object.getPrototypeOf(inst));
    } catch {}

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

    try {
      if (
        (Object.prototype.hasOwnProperty.call(inst, "getPushToken") || !(inst.getPushToken && inst.getPushToken.__ombAsyncWrapped)) &&
        typeof inst.getPushToken === "function" &&
        !inst.getPushToken.__ombAsyncWrapped
      ) {
        Object.defineProperty(inst, "getPushToken", {
          value: makeAsyncGetPushToken(inst.getPushToken),
          configurable: true,
          writable: true,
        });
      }
    } catch {}

    observeActivityInstance(inst, botId || "");
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

  function makeWrappedFactoryStart(origStart) {
    if (typeof origStart !== "function" || origStart.__ombWrapped) return origStart;
    var wrappedStart = function () {
      if (this && (typeof this === "object" || typeof this === "function")) {
        state.factoryInstances.add(this);
      }
      state.flushDeferredEnds();
      var botId = extractBotIdFromStartArgs(arguments);
      sendBridgeWake("", botId);
      var res = origStart.apply(this, arguments);
      if (res && typeof res.then === "function") {
        return res.then(function (inst) {
          return wrapInstance(inst, true, botId);
        });
      }
      return wrapInstance(res, true, botId);
    };
    wrappedStart.__ombWrapped = true;
    return wrappedStart;
  }

  function makeWrappedFactoryGetInstances(origGetInstances) {
    if (typeof origGetInstances !== "function" || origGetInstances.__ombWrapped) return origGetInstances;
    var wrappedGetInstances = function () {
      if (this && (typeof this === "object" || typeof this === "function")) {
        state.factoryInstances.add(this);
      }
      var list = origGetInstances.apply(this, arguments);
      if (Array.isArray(list)) {
        var aliveIds = new Set();
        for (var i = 0; i < list.length; i += 1) {
          var instId = getInstanceId(list[i]);
          if (instId) aliveIds.add(instId);
          wrapInstance(list[i], false, "");
        }
        state.botInstanceIds.forEach(function (trackedId, trackedBotId) {
          if (trackedId && !aliveIds.has(trackedId)) {
            state.endedIds.add(trackedId);
            state.activeBotTokens.delete(trackedBotId);
            state.botInstanceIds.delete(trackedBotId);
          }
        });
      }
      return list;
    };
    wrappedGetInstances.__ombWrapped = true;
    return wrappedGetInstances;
  }

  function patchFactoryMethodsOnTarget(target) {
    if (!target || target === Object.prototype || target === Function.prototype) return false;
    var patchedAny = false;
    try {
      if (typeof target.start === "function") {
        if (!target.start.__ombWrapped) {
          var nextStart = makeWrappedFactoryStart(target.start);
          Object.defineProperty(target, "start", {
            value: nextStart,
            configurable: true,
            writable: true,
          });
        }
        if (target.start && target.start.__ombWrapped) patchedAny = true;
      }
    } catch {}
    try {
      if (typeof target.getInstances === "function") {
        if (!target.getInstances.__ombWrapped) {
          var nextGet = makeWrappedFactoryGetInstances(target.getInstances);
          Object.defineProperty(target, "getInstances", {
            value: nextGet,
            configurable: true,
            writable: true,
          });
        }
        if (target.getInstances && target.getInstances.__ombWrapped) patchedAny = true;
      }
    } catch {}
    return patchedAny;
  }

  function registerFactoryInstance(factoryInst) {
    if (!factoryInst || (typeof factoryInst !== "object" && typeof factoryInst !== "function")) return;
    state.factoryInstances.add(factoryInst);
    try {
      patchFactoryMethodsOnTarget(Object.getPrototypeOf(factoryInst));
    } catch {}
    patchFactoryMethodsOnTarget(factoryInst);
    try {
      if (typeof factoryInst.getInstances === "function") {
        factoryInst.getInstances();
      }
    } catch {}
  }

  function ensureScanInstancesFn() {
    if (typeof state.scanInstances === "function") return;
    state.scanInstances = function () {
      state.factoryInstances.forEach(function (inst) {
        try {
          if (inst && typeof inst.getInstances === "function") {
            inst.getInstances();
          }
        } catch {}
      });
      try {
        var ew = getExpoWidgets();
        var f = ew && ew.LiveActivityFactory;
        if (f && typeof f === "object" && typeof f.getInstances === "function") {
          f.getInstances();
        }
      } catch {}
    };
  }

  function patchExpoWidgetsObject(expoWidgets) {
    if (!expoWidgets || (typeof expoWidgets !== "object" && typeof expoWidgets !== "function")) {
      return false;
    }
    if (typeof expoWidgets.createLiveActivity === "function") {
      return false;
    }
    try {
      if (expoWidgets.LiveActivity && expoWidgets.LiveActivity.prototype) {
        patchActivityPrototype(expoWidgets.LiveActivity.prototype);
      }
    } catch {}

    var factory = expoWidgets.LiveActivityFactory;
    if (!factory) return false;

    var replaced = false;
    if (typeof factory === "function") {
      if (factory.prototype) {
        if (patchFactoryMethodsOnTarget(factory.prototype)) {
          replaced = true;
        }
      }
      if (factory.__ombCtorProxied) {
        replaced = true;
      } else if (typeof Proxy === "function") {
        try {
          var ctorProxy = new Proxy(factory, {
            construct: function (target, argArray, newTarget) {
              var created = Reflect.construct(target, argArray, newTarget);
              registerFactoryInstance(created);
              return created;
            },
            get: function (target, prop, receiver) {
              if (prop === "__ombCtorProxied") return true;
              if (prop === "start" && typeof target.start === "function") {
                return makeWrappedFactoryStart(target.start).bind(target);
              }
              if (prop === "getInstances" && typeof target.getInstances === "function") {
                return makeWrappedFactoryGetInstances(target.getInstances).bind(target);
              }
              return Reflect.get(target, prop, receiver);
            },
          });
          Object.defineProperty(expoWidgets, "LiveActivityFactory", {
            value: ctorProxy,
            configurable: true,
            writable: true,
          });
          if (expoWidgets.LiveActivityFactory === ctorProxy) {
            replaced = true;
          }
        } catch {}
      }
    } else if (typeof factory === "object") {
      state.factoryInstances.add(factory);
      replaced = patchFactoryMethodsOnTarget(factory);
      if (!replaced && typeof Proxy === "function" && typeof factory.start === "function" && typeof factory.getInstances === "function") {
        var proxiedStart = makeWrappedFactoryStart(factory.start);
        var proxiedGet = makeWrappedFactoryGetInstances(factory.getInstances);
        try {
          var objProxy = new Proxy(factory, {
            get: function (target, prop, receiver) {
              if (prop === "start") return proxiedStart.bind(target);
              if (prop === "getInstances") return proxiedGet.bind(target);
              return Reflect.get(target, prop, receiver);
            },
          });
          Object.defineProperty(expoWidgets, "LiveActivityFactory", {
            value: objProxy,
            configurable: true,
            writable: true,
          });
          if (expoWidgets.LiveActivityFactory === objProxy) {
            state.factoryInstances.add(objProxy);
            replaced = true;
          }
        } catch {}
      }
    }

    if (replaced) {
      state.factoryPatched = true;
      ensureScanInstancesFn();
    }
    return replaced;
  }

  function patchLiveActivityFactory() {
    var expoWidgets = getExpoWidgets();
    if (!expoWidgets) return state.factoryPatched;
    return patchExpoWidgetsObject(expoWidgets) || state.factoryPatched;
  }

  function startBackgroundScanner() {
    if (state.scannerStarted) return;
    if (typeof g.setInterval !== "function") return;
    if (typeof g.__ombNativeBridge !== "function" && typeof g.fetch !== "function") return;
    if (!state.factoryPatched) return;
    ensureScanInstancesFn();
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

  if (!state.screenPatch) {
    state.screenPatch = {
      defineHooked: false,
      requireHooked: false,
      defineInterceptedCount: 0,
      metroRequire: null,
      reactMod: null,
      mediaMod: null,
      cardsMod: null,
      rowKindsMod: null,
      origScreenRow: null,
      patchedScreenRow: null,
      rowKindsPatched: false,
      origRegisterPushDevice: null,
      wrappedRegisterPushDevice: null,
      origRegisterActivity: null,
      wrappedRegisterActivity: null,
      lastDeviceClient: null,
      lastDeviceReg: null,
      lastActivityClient: null,
      lastActivityReg: null,
      permissionPrompted: false,
      permissionGrantedThisSession: false,
    };
  }
  var sp = state.screenPatch;

  function assignProperty(target, key, value) {
    try {
      target[key] = value;
      if (target[key] === value) return true;
    } catch {}
    try {
      Object.defineProperty(target, key, {
        value: value,
        configurable: true,
        enumerable: true,
        writable: true,
      });
      return target[key] === value;
    } catch {}
    return false;
  }

  function replaceImageElementSource(reactMod, node, nextSource, onError) {
    if (!reactMod.isValidElement(node)) return null;
    var nodeProps = node.props;
    var rawSource = nodeProps ? nodeProps.source : null;
    var isDataSource =
      (typeof rawSource === "string" && rawSource.indexOf("data:") === 0) ||
      Boolean(
        rawSource &&
          typeof rawSource === "object" &&
          typeof rawSource.uri === "string" &&
          rawSource.uri.indexOf("data:") === 0
      );
    if (isDataSource) {
      var prevOnError = typeof nodeProps.onError === "function" ? nodeProps.onError : null;
      return reactMod.cloneElement(node, {
        source: nextSource,
        onError: function (ev) {
          if (prevOnError) prevOnError(ev);
          onError();
        },
      });
    }
    var children = nodeProps ? nodeProps.children : null;
    if (reactMod.isValidElement(children)) {
      var updatedChild = replaceImageElementSource(reactMod, children, nextSource, onError);
      if (updatedChild) {
        return reactMod.cloneElement(node, null, updatedChild);
      }
    } else if (Array.isArray(children)) {
      var changed = false;
      var mapped = children.map(function (child) {
        var updated = replaceImageElementSource(reactMod, child, nextSource, onError);
        if (updated) {
          changed = true;
          return updated;
        }
        return child;
      });
      if (changed) {
        return reactMod.cloneElement.apply(reactMod, [node, null].concat(mapped));
      }
    }
    return null;
  }

  function createPatchedScreenRow(origScreenRow) {
    var patched = function PatchedScreenRow(props) {
      if ((!sp.reactMod || !sp.mediaMod) && sp.metroRequire) {
        probeKnownScreenModules(sp.metroRequire);
      }
      var reactMod = sp.reactMod;
      var mediaMod = sp.mediaMod;
      if (!reactMod || !mediaMod) {
        return origScreenRow(props);
      }

      var media = mediaMod.useAttachmentMedia();
      // MediaMod.useMediaRevision calls React.useSyncExternalStore(media.subscribe, media.revision, media.revision).
      mediaMod.useMediaRevision(media);
      var failedState = reactMod.useState(null);
      var failedKey = failedState[0];
      var setFailedKey = failedState[1];

      var message = props && props.message;
      if (message && typeof message.png === "string" && message.png.length > 0) {
        return origScreenRow(props);
      }

      var threadId = props && props.context && typeof props.context.threadId === "string" ? props.context.threadId : "";
      var messageId = message && typeof message.id === "string" ? message.id : "";
      if (!message || !message.hasImage || !threadId || !messageId) {
        return origScreenRow(props);
      }

      var remoteSource = null;
      var sourceKey = "";
      try {
        var access =
          media && typeof media.access === "function"
            ? media.access()
            : media && media.access
              ? media.access
              : null;
        remoteSource = access ? mediaMod.screenSource(access, threadId, messageId) : null;
        sourceKey =
          remoteSource && typeof remoteSource === "object"
            ? String(remoteSource.cacheKey || remoteSource.uri || "")
            : "";
      } catch {
        remoteSource = null;
      }

      if (!remoteSource || typeof remoteSource.uri !== "string" || !remoteSource.uri || (sourceKey && failedKey === sourceKey)) {
        return origScreenRow(props);
      }

      var syntheticMessage = Object.assign({}, message, { png: "AA==" });
      var syntheticProps = Object.assign({}, props, { message: syntheticMessage });
      var template = origScreenRow(syntheticProps);
      try {
        var replaced = replaceImageElementSource(reactMod, template, remoteSource, function () {
          if (sourceKey) setFailedKey(sourceKey);
        });
        return replaced || template;
      } catch {
        return template;
      }
    };
    patched.__ombScreenPatched = true;
    return patched;
  }

  function patchScreenEntryOnTable(table) {
    if (!table || typeof table !== "object") return false;
    if (table.screen && typeof table.screen === "object") {
      return assignProperty(table.screen, "Row", sp.patchedScreenRow);
    }
    return false;
  }

  function applyRowKindsPatch() {
    if (!sp.rowKindsMod || !sp.patchedScreenRow) return false;
    var updated = false;
    var defaultKinds = sp.rowKindsMod.ROW_KINDS;
    if (defaultKinds && typeof defaultKinds === "object") {
      if (patchScreenEntryOnTable(defaultKinds)) updated = true;
      if (patchScreenEntryOnTable(defaultKinds.hidden)) updated = true;
      if (patchScreenEntryOnTable(defaultKinds.full)) updated = true;
    }
    if (typeof sp.rowKindsMod.rowKindsFor === "function") {
      var modes = ["hidden", "full"];
      for (var i = 0; i < modes.length; i += 1) {
        try {
          var byMode = sp.rowKindsMod.rowKindsFor(modes[i]);
          if (patchScreenEntryOnTable(byMode)) updated = true;
        } catch {}
      }
    }
    if (updated) sp.rowKindsPatched = true;
    return updated;
  }

  function isPermissionGrantedResponse(res) {
    if (!res || typeof res !== "object") return false;
    if (res.granted === true || res.status === "granted") return true;
    var ios = res.ios;
    return Boolean(ios && typeof ios === "object" && typeof ios.status === "number" && ios.status >= 2);
  }

  function isPermissionUndeterminedResponse(res) {
    if (!res || typeof res !== "object") return false;
    if (res.status === "undetermined") return true;
    var ios = res.ios;
    if (ios && typeof ios === "object" && ios.status === 0) return true;
    return res.granted === false && res.canAskAgain !== false && res.status !== "denied";
  }

  function replayRegistrationsAfterPermissionGrant() {
    if (!sp.permissionGrantedThisSession) return;
    if (typeof sp.origRegisterPushDevice === "function" && sp.lastDeviceClient && sp.lastDeviceReg) {
      var devKinds = sp.lastDeviceReg.kinds;
      if (Array.isArray(devKinds) && devKinds.length === 0) {
        var nextDevReg = Object.assign({}, sp.lastDeviceReg, {
          kinds: ["approval", "question", "sign-in", "done"],
        });
        sp.lastDeviceReg = nextDevReg;
        sendBridgeJson("/device-reg", nextDevReg);
        try {
          var devRes = sp.origRegisterPushDevice(sp.lastDeviceClient, nextDevReg);
          if (devRes && typeof devRes.catch === "function") devRes.catch(function () {});
        } catch {}
      }
    }
    if (typeof sp.origRegisterActivity === "function" && sp.lastActivityClient && sp.lastActivityReg) {
      var actKinds = sp.lastActivityReg.kinds;
      if ((Array.isArray(actKinds) && actKinds.length === 0) || "startToken" in sp.lastActivityReg) {
        var nextActReg = sanitizeActivityReg(sp.lastActivityReg, state.appState !== "active");
        sp.lastActivityReg = nextActReg;
        sendBridgeJson("/activity-reg", nextActReg);
        try {
          var actRes = sp.origRegisterActivity(sp.lastActivityClient, nextActReg);
          if (actRes && typeof actRes.catch === "function") actRes.catch(function () {});
        } catch {}
      }
    }
  }

  function ensureNotificationPermissionRequested() {
    if (sp.permissionPrompted) return;
    var permMod = null;
    try {
      var expo = g.expo;
      var modules = expo && expo.modules;
      permMod = modules ? modules.ExpoNotificationPermissionsModule || modules.ExpoNotificationsPermissionsModule : null;
    } catch {}
    if (!permMod || typeof permMod.getPermissionsAsync !== "function" || typeof permMod.requestPermissionsAsync !== "function") {
      return;
    }
    sp.permissionPrompted = true;
    try {
      Promise.resolve(permMod.getPermissionsAsync())
        .then(function (current) {
          if (!isPermissionUndeterminedResponse(current)) {
            return null;
          }
          return Promise.resolve(
            permMod.requestPermissionsAsync({
              ios: { allowAlert: true, allowBadge: true, allowSound: true },
            })
          ).then(function (afterReq) {
            if (isPermissionGrantedResponse(afterReq)) {
              sp.permissionGrantedThisSession = true;
              replayRegistrationsAfterPermissionGrant();
            }
            return null;
          });
        })
        .catch(function () {});
    } catch {}
  }

  function wrapRegisterPushFunctions(exp) {
    if (typeof exp.registerPushDevice === "function" && !exp.registerPushDevice.__ombPushWrapped) {
      var origDev = sp.origRegisterPushDevice || exp.registerPushDevice;
      sp.origRegisterPushDevice = origDev;
      if (!sp.wrappedRegisterPushDevice) {
        var wrappedDev = function (client, reg) {
          var effectiveReg = reg;
          if (reg && typeof reg === "object") {
            if (sp.permissionGrantedThisSession && Array.isArray(reg.kinds) && reg.kinds.length === 0) {
              effectiveReg = Object.assign({}, reg, {
                kinds: ["approval", "question", "sign-in", "done"],
              });
            }
            sp.lastDeviceClient = client;
            sp.lastDeviceReg = effectiveReg;
            sendBridgeJson("/device-reg", effectiveReg);
            if (Array.isArray(effectiveReg.kinds) && effectiveReg.kinds.length === 0) {
              ensureNotificationPermissionRequested();
            }
          }
          return origDev.call(this, client, effectiveReg);
        };
        wrappedDev.__ombPushWrapped = true;
        sp.wrappedRegisterPushDevice = wrappedDev;
      }
      assignProperty(exp, "registerPushDevice", sp.wrappedRegisterPushDevice);
    }

    if (typeof exp.registerActivity === "function" && !exp.registerActivity.__ombPushWrapped) {
      var origAct = sp.origRegisterActivity || exp.registerActivity;
      sp.origRegisterActivity = origAct;
      if (!sp.wrappedRegisterActivity) {
        var wrappedAct = function (client, reg) {
          var effectiveReg = reg;
          if (reg && typeof reg === "object") {
            if (Array.isArray(reg.activities)) {
              for (var i = 0; i < reg.activities.length; i += 1) {
                var actItem = reg.activities[i];
                if (actItem && typeof actItem.botId === "string" && actItem.botId && typeof actItem.token === "string") {
                  var normTok = normalizeHexToken(actItem.token);
                  if (normTok) {
                    state.activeBotTokens.set(actItem.botId, normTok);
                  }
                }
              }
              var incomingBots = new Set();
              for (var j = 0; j < reg.activities.length; j += 1) {
                var entry = reg.activities[j];
                if (entry && typeof entry.botId === "string" && entry.botId) {
                  incomingBots.add(entry.botId);
                }
              }
              state.activeBotTokens.forEach(function (_tok, bId) {
                var trackedInstId = state.botInstanceIds.get(bId) || "";
                if (!incomingBots.has(bId) && (!trackedInstId || state.endedIds.has(trackedInstId))) {
                  state.activeBotTokens.delete(bId);
                  state.botInstanceIds.delete(bId);
                }
              });
            }
            effectiveReg = sanitizeActivityReg(reg, state.appState !== "active");
            sp.lastActivityClient = client;
            sp.lastActivityReg = effectiveReg;
            sendBridgeJson("/activity-reg", effectiveReg);
            if (Array.isArray(effectiveReg.kinds) && effectiveReg.kinds.length === 0) {
              ensureNotificationPermissionRequested();
            }
          }
          return origAct.call(this, client, effectiveReg);
        };
        wrappedAct.__ombPushWrapped = true;
        sp.wrappedRegisterActivity = wrappedAct;
      }
      assignProperty(exp, "registerActivity", sp.wrappedRegisterActivity);
    }
  }

  function inspectModuleExports(exp, reqFn) {
    if (typeof reqFn === "function" && !sp.metroRequire) {
      sp.metroRequire = reqFn;
    }
    if (!exp || typeof exp !== "object") return;

    if (
      !sp.reactMod &&
      typeof exp.useState === "function" &&
      typeof exp.createElement === "function" &&
      typeof exp.cloneElement === "function" &&
      typeof exp.isValidElement === "function"
    ) {
      sp.reactMod = exp;
    }

    if (
      !sp.mediaMod &&
      typeof exp.useAttachmentMedia === "function" &&
      typeof exp.useMediaRevision === "function" &&
      typeof exp.screenSource === "function"
    ) {
      sp.mediaMod = exp;
    }

    if (
      typeof exp.ScreenRow === "function" &&
      (typeof exp.DigestRow === "function" || typeof exp.CompactionRow === "function")
    ) {
      sp.cardsMod = exp;
      if (!exp.ScreenRow.__ombScreenPatched) {
        sp.origScreenRow = exp.ScreenRow;
        sp.patchedScreenRow = createPatchedScreenRow(exp.ScreenRow);
      } else if (!sp.patchedScreenRow) {
        sp.patchedScreenRow = exp.ScreenRow;
      }
      if (sp.patchedScreenRow && exp.ScreenRow !== sp.patchedScreenRow) {
        assignProperty(exp, "ScreenRow", sp.patchedScreenRow);
      }
      applyRowKindsPatch();
    }

    if (typeof exp.rowKindsFor === "function" && exp.ROW_KINDS && typeof exp.ROW_KINDS === "object") {
      sp.rowKindsMod = exp;
      applyRowKindsPatch();
    }

    if (typeof exp.registerPushDevice === "function" || typeof exp.registerActivity === "function") {
      wrapRegisterPushFunctions(exp);
    }

    if (exp.LiveActivityFactory) {
      patchExpoWidgetsObject(exp);
      startBackgroundScanner();
    }
    if (exp.default && typeof exp.default === "object" && exp.default.LiveActivityFactory) {
      patchExpoWidgetsObject(exp.default);
      startBackgroundScanner();
    }
    if (exp.botActivity && typeof exp.botActivity === "object" && exp.botActivity.nativeLiveActivityFactory) {
      registerFactoryInstance(exp.botActivity.nativeLiveActivityFactory);
      state.factoryPatched = true;
      ensureScanInstancesFn();
      startBackgroundScanner();
    }
  }

  function wrapMetroDefine(defineFn) {
    if (typeof defineFn !== "function" || defineFn.__ombScreenHooked) return defineFn;
    var wrappedDefine = function (factory) {
      if (typeof factory !== "function" || factory.__ombScreenWrapped) {
        return defineFn.apply(this, arguments);
      }
      sp.defineInterceptedCount += 1;
      var args = Array.prototype.slice.call(arguments);
      var wrappedFactory = function (globalObj, req, importDefault, importAll, moduleObject, exportsObj) {
        var res = factory.apply(this, arguments);
        var resolvedExports = moduleObject && moduleObject.exports ? moduleObject.exports : exportsObj;
        inspectModuleExports(resolvedExports, req);
        return res;
      };
      wrappedFactory.__ombScreenWrapped = true;
      args[0] = wrappedFactory;
      return defineFn.apply(this, args);
    };
    wrappedDefine.__ombScreenHooked = true;
    return wrappedDefine;
  }

  function wrapMetroRequire(requireFn) {
    if (typeof requireFn !== "function" || requireFn.__ombScreenHooked) return requireFn;
    sp.metroRequire = requireFn;
    if (typeof Proxy === "function") {
      var proxied = new Proxy(requireFn, {
        apply: function (target, thisArg, argArray) {
          var exp = Reflect.apply(target, thisArg, argArray);
          inspectModuleExports(exp, target);
          return exp;
        },
        get: function (target, prop, receiver) {
          if (prop === "__ombScreenHooked") return true;
          return Reflect.get(target, prop, receiver);
        },
      });
      return proxied;
    }
    return requireFn;
  }

  function probeKnownScreenModules(requireFn) {
    // Metro's guarded require forwards missing IDs to ErrorUtils.reportFatalError; unguarded throws a plain Error.
    var loader = requireFn && typeof requireFn.unguarded === "function" ? requireFn.unguarded : requireFn;
    if (typeof loader !== "function") return;
    var candidateIds = [54, 56, 1511, 1545, 2211, 2366, 2376];
    for (var i = 0; i < candidateIds.length; i += 1) {
      try {
        inspectModuleExports(loader(candidateIds[i]), requireFn);
      } catch {}
    }
  }

  function installMetroDefineTrap() {
    if (typeof g.__d === "function") {
      if (!g.__d.__ombScreenHooked) {
        assignProperty(g, "__d", wrapMetroDefine(g.__d));
      }
      sp.defineHooked = true;
      return;
    }
    if (sp.defineHooked) return;
    try {
      var currentDefine = g.__d;
      Object.defineProperty(g, "__d", {
        configurable: true,
        enumerable: true,
        get: function () {
          return currentDefine;
        },
        set: function (next) {
          currentDefine = wrapMetroDefine(next);
        },
      });
      sp.defineHooked = true;
    } catch {}
  }

  function patchMetroScreenRow() {
    if (typeof g.__d === "function") {
      installMetroDefineTrap();
    }

    if (typeof g.__r === "function") {
      if (!g.__r.__ombScreenHooked) {
        assignProperty(g, "__r", wrapMetroRequire(g.__r));
      }
      sp.requireHooked = true;
      if (!sp.rowKindsPatched || !sp.wrappedRegisterActivity) {
        probeKnownScreenModules(g.__r);
      }
    } else if (!sp.requireHooked) {
      try {
        var currentRequire = g.__r;
        Object.defineProperty(g, "__r", {
          configurable: true,
          enumerable: true,
          get: function () {
            return currentRequire;
          },
          set: function (next) {
            currentRequire = wrapMetroRequire(next);
            installMetroDefineTrap();
            Promise.resolve().then(function () {
              runPostBundleInit();
              schedulePostBundleRetries();
            });
          },
        });
        sp.requireHooked = true;
      } catch {}
    }
  }

  function runPostBundleInit() {
    bindInitialAppState();
    patchLiveActivityFactory();
    startBackgroundScanner();
    patchMetroScreenRow();
    ensureNotificationPermissionRequested();
  }

  var retryLoopScheduled = false;
  function schedulePostBundleRetries() {
    if (retryLoopScheduled) return;
    if (state.factoryPatched && state.scannerStarted && state.appStateBound) return;
    if (typeof g.setTimeout !== "function") return;
    retryLoopScheduled = true;
    var attempts = 0;
    var retry = function () {
      attempts += 1;
      runPostBundleInit();
      if ((!state.factoryPatched || !state.scannerStarted || !state.appStateBound) && attempts < 25) {
        g.setTimeout(retry, 150);
      } else {
        retryLoopScheduled = false;
      }
    };
    g.setTimeout(retry, 100);
  }

  runPostBundleInit();
  schedulePostBundleRetries();
})();
