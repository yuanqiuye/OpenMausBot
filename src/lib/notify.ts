import type { Notification } from "../../shared/notification";
import { plainPreviewText } from "../../shared/plain-preview";
import { finishedNotificationsEnabled, notificationSoundsEnabled, reportNotificationsEnabled } from "./notification-preferences";
import { botNotificationIcon, type NotificationIconBot } from "./notify-icon";

export type NotifyFrame = Notification;

export type NotificationTarget = Pick<NotifyFrame, "botId" | "threadId">;

/** On a team's page in the desktop app, its name: notifications then say which place they come from ("Acme · Scout"). */
let placeName: string | null = null;
export function setNotificationPlace(name: string | null) {
  placeName = name;
}

/** Call from the click: browsers may reject a permission request made later from an SSE frame. Resolves to the permission now in force. */
export async function requestNotificationPermission(): Promise<NotificationPermission | null> {
  if (typeof Notification === "undefined") return null;
  try {
    return Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  } catch {
    return Notification.permission;
  }
}

export interface NotificationBotIdentity extends NotificationIconBot {
  name?: string | null;
}

export function buildNotificationOptions(bot: NotificationBotIdentity, kind?: string): NotificationOptions {
  return { tag: `openmausbot:${bot.id}`, icon: botNotificationIcon(bot, kind) };
}

export function showNotification(
  frame: NotifyFrame,
  onOpen: (target: NotificationTarget) => void,
  botOrAvatarUrl?: NotificationBotIdentity | string | null,
  visibleThreadId?: string | null,
) {
  if (typeof Notification === "undefined") return;
  if (frame.kind === "done" && !(frame.routine ? reportNotificationsEnabled() : finishedNotificationsEnabled())) return;
  const spend = frame.kind === "spend";
  if (!spend && document.hasFocus() && visibleThreadId === frame.threadId) return;
  if (Notification.permission !== "granted") return;

  const bot: NotificationBotIdentity = typeof botOrAvatarUrl === "object" && botOrAvatarUrl !== null
    ? botOrAvatarUrl
    : { id: frame.botId, avatarUrl: botOrAvatarUrl };
  const baseTitle = !spend && bot.name && !frame.title.includes(bot.name) ? `${bot.name} · ${frame.title}` : frame.title;
  const title = placeName ? `${placeName} · ${baseTitle}` : baseTitle;
  // Entries saved before the harness spoke plain text still carry Markdown.
  const body = plainPreviewText(frame.body);
  const options: NotificationOptions = {
    body,
    ...buildNotificationOptions(bot, frame.kind),
    ...(spend ? { tag: "openmausbot:spend", icon: undefined } : {}),
    ...(notificationSoundsEnabled() ? {} : { silent: true }),
  };
  const shownByPage = () => {
    new Notification(title, options).onclick = () => {
      window.focus();
      onOpen({ botId: frame.botId, threadId: frame.threadId });
    };
  };
  const desktop = window.ogb?.desktopNotifications;
  if (!desktop) return shownByPage();
  void desktop.show({
    title, body, tag: options.tag, silent: options.silent === true, picture: options.icon, botId: frame.botId, threadId: frame.threadId,
  }).then((shown) => { if (!shown) shownByPage(); }, shownByPage);
}
