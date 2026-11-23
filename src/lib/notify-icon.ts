import { botAvatarProfile } from "../../shared/bot-avatar";
import { resolveBotNotificationVisual, type NotificationMascotMood } from "../../shared/bot-notification-visual";
import { CARVED_BODIES, type CarvedBody, type CarvedBodyId } from "../../shared/carved-bodies";
import { MASCOT_BODIES, type MascotBody } from "../../shared/mascot-bodies";
import { EXPRESSIONS, FACE_CENTRE, MOUTHS, MOUTH_STROKE, mouthFrame, type Ring } from "../components/cursor-face-data";
import { VIEW_SPAN } from "../components/mascot-motion";

const ICON_SIZE = 128;
const ICON_CACHE = new Map<string, string>();

function isCarvedBodyId(value: unknown): value is CarvedBodyId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CARVED_BODIES, value);
}

export interface NotificationIconBot {
  id: string;
  avatarUrl?: string | null;
  avatarCrop?: unknown;
  color?: unknown;
  mascotBody?: unknown;
  mascotFaceColor?: unknown;
}

interface Canvas2DLike {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  roundRect?(x: number, y: number, w: number, h: number, radii?: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  closePath(): void;
  fill(path?: Path2D): void;
  stroke(path?: Path2D): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): { addColorStop(offset: number, color: string): void };
  fillStyle: string | object;
  strokeStyle: string | object;
  lineWidth: number;
  lineCap: CanvasLineCap;
}

export interface CanvasFactoryResult {
  getContext(type: "2d"): Canvas2DLike | null;
  toDataURL(type: "image/png"): string;
}

function defaultCanvasFactory(size: number): CanvasFactoryResult | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const canvas = document.createElement("canvas");
  if (!canvas || typeof canvas.getContext !== "function" || typeof canvas.toDataURL !== "function") return null;
  canvas.width = size;
  canvas.height = size;
  return canvas as unknown as CanvasFactoryResult;
}

function extractPathD(svgMarkup: string): string | null {
  const match = /<path[^>]*\bd="([^"]+)"/.exec(svgMarkup);
  return match?.[1] ?? null;
}

function parseFitTransform(fit: string): { tx: number; ty: number; scale: number } {
  const translateMatch = /translate\(\s*([+-]?\d*\.?\d+)\s+([+-]?\d*\.?\d+)\s*\)/.exec(fit);
  const scaleMatch = /scale\(\s*([+-]?\d*\.?\d+)\s*\)/.exec(fit);
  return {
    tx: translateMatch ? Number(translateMatch[1]) : 0,
    ty: translateMatch ? Number(translateMatch[2]) : 0,
    scale: scaleMatch ? Number(scaleMatch[1]) : 1,
  };
}

function mixHex(baseHex: string, tintHex: string, weight: number): string {
  const parse = (hex: string): [number, number, number] => {
    const clean = hex.replace(/^#/, "");
    return [
      Number.parseInt(clean.slice(0, 2), 16) || 0,
      Number.parseInt(clean.slice(2, 4), 16) || 0,
      Number.parseInt(clean.slice(4, 6), 16) || 0,
    ];
  };
  const [br, bg, bb] = parse(baseHex);
  const [tr, tg, tb] = parse(tintHex);
  const ch = (a: number, b: number) => Math.round(a + (b - a) * weight).toString(16).padStart(2, "0");
  return `#${ch(br, tr)}${ch(bg, tg)}${ch(bb, tb)}`;
}

function expressionForMood(mood: NotificationMascotMood): number {
  if (mood === "needsYou") return 21;
  if (mood === "unread") return 19;
  return 0;
}

function traceRing(ctx: Canvas2DLike, ring: Ring) {
  if (ring.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(ring[0]![0], ring[0]![1]);
  for (let i = 1; i < ring.length; i += 1) {
    ctx.lineTo(ring[i]![0], ring[i]![1]);
  }
  ctx.closePath();
  ctx.fill();
}

function strokeMouth(ctx: Canvas2DLike, rings: Ring[], spec: number[], ink: string) {
  if (spec.length < 4) return;
  const frame = mouthFrame(rings, spec);
  const ca = Math.cos(frame.angle);
  const sa = Math.sin(frame.angle);
  const at = (lx: number, ly: number): [number, number] => [
    frame.x + lx * ca - ly * sa,
    frame.y + lx * sa + ly * ca,
  ];
  const a = at(-spec[0]!, 0);
  const c = at(0, spec[1]!);
  const b = at(spec[0]!, 0);
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.quadraticCurveTo(c[0], c[1], b[0], b[1]);
  ctx.strokeStyle = ink;
  ctx.lineWidth = MOUTH_STROKE;
  ctx.lineCap = "round";
  ctx.stroke();
}

function drawMascotSilhouette(
  ctx: Canvas2DLike,
  silhouette: MascotBody,
  gradientStops: [string, string, string],
  faceInk: string,
  mood: NotificationMascotMood,
) {
  const d = extractPathD(silhouette.clip);
  if (!d || typeof Path2D !== "function") return false;
  const pad = 10;
  const scale = (ICON_SIZE - pad * 2) / VIEW_SPAN;
  ctx.save();
  ctx.translate(pad, pad);
  ctx.scale(scale, scale);
  ctx.translate(15, 15);

  const fit = parseFitTransform(silhouette.fit);
  ctx.save();
  ctx.translate(fit.tx, fit.ty);
  ctx.scale(fit.scale, fit.scale);
  const grad = ctx.createLinearGradient(200, 0, 0, 200);
  grad.addColorStop(0, gradientStops[0]);
  grad.addColorStop(0.55, gradientStops[1]);
  grad.addColorStop(1, gradientStops[2]);
  ctx.fillStyle = grad;
  ctx.fill(new Path2D(d));
  ctx.restore();

  const exprIndex = expressionForMood(mood) % EXPRESSIONS.length;
  const rings = EXPRESSIONS[exprIndex] ?? EXPRESSIONS[0]!;
  const mouth = MOUTHS[exprIndex] ?? MOUTHS[0]!;
  ctx.save();
  ctx.translate(silhouette.anchor.x, silhouette.anchor.y);
  ctx.scale(silhouette.anchor.scale, silhouette.anchor.scale);
  ctx.translate(-FACE_CENTRE[0], -FACE_CENTRE[1]);
  ctx.fillStyle = faceInk;
  for (const ring of rings) traceRing(ctx, ring);
  strokeMouth(ctx, rings, mouth, faceInk);
  ctx.restore();

  ctx.restore();
  return true;
}

function drawPill(ctx: Canvas2DLike, x: number, y: number, w: number, h: number) {
  const r = Math.min(w, h) / 2;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x - w / 2, y - h / 2, w, h, r);
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fill();
}

function drawCarvedSilhouette(ctx: Canvas2DLike, carved: CarvedBody, colorHex: string) {
  if (typeof Path2D !== "function") return false;
  const pad = 10;
  const scale = (ICON_SIZE - pad * 2) / 240;
  const bodyPaint = carved.paint === "bone"
    ? (carved.bone ?? "#F2EFE9")
    : carved.paint === "pale"
      ? mixHex("#FFFFFF", colorHex, 0.22)
      : colorHex;

  ctx.save();
  ctx.translate(pad, pad);
  ctx.scale(scale, scale);
  for (const part of carved.parts) {
    ctx.fillStyle = part.fill === "body" ? bodyPaint : part.fill === "accent" ? colorHex : part.fill;
    ctx.fill(new Path2D(part.d));
  }
  ctx.fillStyle = carved.eyes.ink;
  drawPill(ctx, carved.eyes.cx - carved.eyes.dx, carved.eyes.cy, carved.eyes.w, carved.eyes.h);
  drawPill(ctx, carved.eyes.cx + carved.eyes.dx, carved.eyes.cy, carved.eyes.w, carved.eyes.h);
  ctx.restore();
  return true;
}

export function botNotificationIcon(
  bot: NotificationIconBot | null | undefined,
  kind?: string,
  canvasFactory: (size: number) => CanvasFactoryResult | null = defaultCanvasFactory,
): string | undefined {
  if (!bot) return undefined;
  const profile = botAvatarProfile(bot);
  if (profile.avatarCrop !== "mascot" && profile.avatarUrl) return profile.avatarUrl;
  const hasMascotAppearance = bot.avatarCrop === "mascot" || bot.color !== undefined || bot.mascotBody !== undefined;
  if (!hasMascotAppearance) return profile.avatarUrl ?? undefined;

  const visual = resolveBotNotificationVisual(bot, kind);
  const mood: NotificationMascotMood = visual.mood ?? "unread";
  const bodyKey = isCarvedBodyId(bot.mascotBody) ? bot.mascotBody : visual.body;
  const cacheKey = `${bodyKey}:${visual.color}:${visual.faceInk}:${mood}`;
  const cached = ICON_CACHE.get(cacheKey);
  if (cached) return cached;

  const canvas = canvasFactory(ICON_SIZE);
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return undefined;

  ctx.save();
  ctx.beginPath();
  ctx.arc(ICON_SIZE / 2, ICON_SIZE / 2, ICON_SIZE / 2 - 2, 0, Math.PI * 2);
  ctx.fillStyle = mixHex("#16181D", visual.color, 0.18);
  ctx.fill();
  ctx.restore();

  const drawn = isCarvedBodyId(bot.mascotBody)
    ? drawCarvedSilhouette(ctx, CARVED_BODIES[bot.mascotBody], visual.color)
    : drawMascotSilhouette(ctx, MASCOT_BODIES[visual.body], visual.gradient, visual.faceInk, mood);
  if (!drawn) return undefined;

  const dataUrl = canvas.toDataURL("image/png");
  if (!dataUrl.startsWith("data:image/png;base64,")) return undefined;
  if (canvasFactory === defaultCanvasFactory) ICON_CACHE.set(cacheKey, dataUrl);
  return dataUrl;
}
