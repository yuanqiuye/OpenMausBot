import { mascotFaceInk } from "../packages/phone-protocol/src/bot-avatar.ts";
import { botMascotBody, type MascotBodyId } from "../packages/phone-protocol/src/mascot-bodies.ts";
import { MAUS_COLOR_NAMES, type MausColor } from "./wire.ts";

export type NotificationMascotMood = "needsYou" | "working" | "unread" | "idle";

/** Compact mascot visual metadata carried in direct APNs `omb.botVisual` and desktop icon renderers. */
export interface BotNotificationVisual {
  color: string;
  gradient: [string, string, string];
  body: MascotBodyId;
  faceInk: string;
  mood?: NotificationMascotMood;
}

export const BOT_NOTIFICATION_COLORS: Record<MausColor, string> = {
  green: "#009957",
  blue: "#377FE6",
  red: "#D94B52",
  orange: "#E78531",
  purple: "#8057C8",
  cyan: "#0EA5C6",
  pink: "#D84F8B",
  yellow: "#D8A729",
  teal: "#01A492",
  coral: "#E5634E",
  silver: "#A8ADB4",
  chrome: "#B3BAC4",
};

const CHROME_GRADIENT: [string, string, string] = ["#F1F4F7", "#AEB8C3", "#66717E"];
const CHROME_EYES = "#1E2833";
const COLOR_SET: ReadonlySet<string> = new Set(MAUS_COLOR_NAMES);

function mixHex(hex: string, toward: string, ratio: number): string {
  const from = Number.parseInt(hex.slice(1), 16);
  const to = Number.parseInt(toward.slice(1), 16);
  const channel = (shift: number) => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * ratio);
  };
  return `#${[channel(16), channel(8), channel(0)]
    .map((part) => part.toString(16).padStart(2, "0").toUpperCase())
    .join("")}`;
}

export function botNotificationGradient(color: MausColor): [string, string, string] {
  if (color === "chrome") return CHROME_GRADIENT;
  const fill = BOT_NOTIFICATION_COLORS[color];
  return [mixHex(fill, "#FFFFFF", 0.55), fill, mixHex(fill, "#000000", 0.42)];
}

export function notificationMoodForKind(kind: string): NotificationMascotMood {
  switch (kind) {
    case "approval":
    case "question":
    case "sign-in":
    case "secret":
    case "turn-failed":
    case "routine-failed":
    case "incident":
      return "needsYou";
    case "wait":
      return "working";
    default:
      return "unread";
  }
}

export function resolveBotNotificationVisual(
  bot?: { color?: unknown; mascotBody?: unknown; mascotFaceColor?: unknown } | null,
  kind?: string,
): BotNotificationVisual {
  const colorName: MausColor = typeof bot?.color === "string" && COLOR_SET.has(bot.color)
    ? (bot.color as MausColor)
    : "purple";
  const color = BOT_NOTIFICATION_COLORS[colorName];
  const gradient = botNotificationGradient(colorName);
  const body = botMascotBody(bot?.mascotBody);
  const faceInk = (mascotFaceInk(bot?.mascotFaceColor) ?? (colorName === "chrome" ? CHROME_EYES : "#FFFFFF")).toUpperCase();
  return {
    color,
    gradient,
    body,
    faceInk,
    ...(kind ? { mood: notificationMoodForKind(kind) } : {}),
  };
}
