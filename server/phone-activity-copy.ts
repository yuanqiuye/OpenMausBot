import type { ActivityAsk, PhoneActivityRegistration } from "../shared/phone-push.ts";
import type { DirectApnsActivityAnswer } from "./apns-direct.ts";
import { redactSecretsInText } from "./redact.ts";
import { conversationLanguage } from "./server-lines.ts";

export const ACTIVITY_STATUS_MAX = 72;

export function clipActivityStatus(value: string, max = ACTIVITY_STATUS_MAX): string {
  const safe = redactSecretsInText(value);
  const points = [...safe.replace(/[\p{Cc}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim()];
  if (!points.length) return "";
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : points.join("");
}

export function detectPhoneLanguage(registration: PhoneActivityRegistration, threadId: string): string {
  const sample = [
    registration.headlines.working,
    registration.headlines.needsYou,
    registration.statuses?.working ?? "",
    registration.statuses?.needsYou.approval ?? "",
    registration.statuses?.needsYou.question ?? "",
  ].join(" ");
  if (/[\u3040-\u30ff]/u.test(sample)) return "ja";
  if (/[\uac00-\ud7af]/u.test(sample)) return "ko";
  if (/\p{Script=Han}/u.test(sample)) {
    if (/[體對話請務題開關處認應檢視動態島進度問]/u.test(sample)) return "zh-tw";
    if (/[体对话请务题开关处认应检视动态岛进度问]/u.test(sample)) return "zh";
    const conv = conversationLanguage(threadId) ?? "";
    return conv.startsWith("zh") ? conv : "zh-tw";
  }
  return conversationLanguage(threadId) ?? "en";
}

const STEP_LABELS: Record<string, Record<string, string>> = {
  "zh-tw": {
    command: "執行",
    edit: "編輯",
    write: "寫入",
    read: "讀取",
    search: "搜尋",
    web: "搜尋網頁",
    fetch: "擷取網頁",
    tool: "使用工具",
    retrying: "重新嘗試中",
    waiting: "等待外部作業",
  },
  zh: {
    command: "执行",
    edit: "编辑",
    write: "写入",
    read: "读取",
    search: "搜索",
    web: "搜索网页",
    fetch: "抓取网页",
    tool: "使用工具",
    retrying: "正在重试",
    waiting: "等待外部操作",
  },
  ja: {
    command: "実行中",
    edit: "編集中",
    write: "書込中",
    read: "読込中",
    search: "検索中",
    web: "Web検索",
    fetch: "ページ取得",
    tool: "ツール実行",
    retrying: "再試行中",
    waiting: "待機中",
  },
  ko: {
    command: "실행 중",
    edit: "편집 중",
    write: "작성 중",
    read: "읽는 중",
    search: "검색 중",
    web: "웹 검색",
    fetch: "페이지 조회",
    tool: "도구 실행",
    retrying: "재시도 중",
    waiting: "대기 중",
  },
  en: {
    command: "Running",
    edit: "Editing",
    write: "Writing",
    read: "Reading",
    search: "Searching",
    web: "Searching web",
    fetch: "Fetching page",
    tool: "Using tool",
    retrying: "Retrying",
    waiting: "Waiting",
  },
};

function langBucket(language: string): "zh-tw" | "zh" | "ja" | "ko" | "en" {
  if (language === "zh-tw" || language === "zh-hk") return "zh-tw";
  if (language.startsWith("zh")) return "zh";
  if (language.startsWith("ja")) return "ja";
  if (language.startsWith("ko")) return "ko";
  return "en";
}

export function formatProgressStep(
  language: string,
  step: { activity: string; target?: string; file?: string; tool?: string },
): string {
  const bucket = langBucket(language);
  const table = STEP_LABELS[bucket]!;
  const verb = table[step.activity] ?? table.tool!;
  const rawSubject = step.target || step.file || step.tool || "";
  const concise = step.activity === "edit" || step.activity === "write" || step.activity === "read"
    ? (rawSubject.split(/[\\/]/).filter(Boolean).pop() ?? rawSubject)
    : rawSubject;
  const subject = clipActivityStatus(concise, 48);
  if (!subject || step.activity === "retrying" || step.activity === "waiting") return clipActivityStatus(verb);
  return clipActivityStatus(`${verb} · ${subject}`);
}

export function formatCompletionStatus(
  language: string,
  botName: string,
  done: { kind: string; text?: string } | undefined,
  includePreview: boolean,
): { headline: string; status: string } {
  const bucket = langBucket(language);
  const failed = done?.kind === "turn-failed" || done?.kind === "routine-failed" || done?.kind === "incident";
  const label = failed
    ? (bucket === "zh-tw" ? "執行失敗" : bucket === "zh" ? "执行失败" : bucket === "ja" ? "失敗しました" : bucket === "ko" ? "실패함" : "Failed")
    : (bucket === "zh-tw" || bucket === "zh" ? "已完成" : bucket === "ja" ? "完了しました" : bucket === "ko" ? "완료됨" : "Finished");
  const detail = includePreview && done?.text ? clipActivityStatus(done.text, 56) : "";
  return {
    headline: clipActivityStatus(`${botName} · ${label}`, 120),
    status: detail ? clipActivityStatus(`${label} · ${detail}`) : label,
  };
}

export function buildNeedsYouAnswers(
  language: string,
  scheme: PhoneActivityRegistration["scheme"],
  threadId: string,
  ask: ActivityAsk,
): DirectApnsActivityAnswer[] {
  const bucket = langBucket(language);
  const viewLabel = bucket === "zh-tw"
    ? "查看對話"
    : bucket === "zh"
      ? "查看对话"
      : bucket === "ja"
        ? "会話を見る"
        : bucket === "ko"
          ? "대화 보기"
          : "View chat";
  const actionLabel = ask === "approval"
    ? (bucket === "zh-tw" ? "前往核准" : bucket === "zh" ? "前往批准" : bucket === "ja" ? "承認する" : bucket === "ko" ? "승인하기" : "Review")
    : ask === "question"
      ? (bucket === "zh-tw" || bucket === "zh" ? "前往回答" : bucket === "ja" ? "回答する" : bucket === "ko" ? "답변하기" : "Reply")
      : ask === "signIn"
        ? (bucket === "zh-tw" ? "前往登入" : bucket === "zh" ? "前往登录" : bucket === "ja" ? "サインイン" : bucket === "ko" ? "로그인" : "Sign in")
        : (bucket === "zh-tw" ? "立即處理" : bucket === "zh" ? "立即处理" : bucket === "ja" ? "確認する" : bucket === "ko" ? "확인하기" : "Open");
  const encoded = encodeURIComponent(threadId);
  return [
    { label: viewLabel, link: `${scheme}://chat/${encoded}?from=island`, refusal: true },
    { label: actionLabel, link: `${scheme}://chat/${encoded}?focus=${ask}`, refusal: false },
  ];
}
