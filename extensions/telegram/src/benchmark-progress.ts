import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { sendMessageTelegram } from "./send.js";

type TaskKeyParams = {
  chatId: number;
  messageId: number;
  threadId?: number;
};

type TelegramBenchmarkNoticeParams = TaskKeyParams & {
  cfg: OpenClawConfig;
  token: string | undefined;
  accountId: string;
  api: Bot["api"];
};

const taskStartTimes = new Map<string, number>();
const MAX_TRACKED_TASKS = 512;
const SCREENSHOT_TIMEOUT_MS = 30_000;

function buildTaskKey(params: TaskKeyParams): string {
  return `${params.chatId}:${params.messageId}:${params.threadId ?? "root"}`;
}

function pruneTrackedTasks(): void {
  while (taskStartTimes.size > MAX_TRACKED_TASKS) {
    const oldestKey = taskStartTimes.keys().next().value;
    if (!oldestKey) {
      return;
    }
    taskStartTimes.delete(oldestKey);
  }
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(2)} s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = ((durationMs % 60_000) / 1000).toFixed(2);
  return `${minutes} min ${seconds} s`;
}

async function sendBenchmarkText(
  params: TelegramBenchmarkNoticeParams,
  text: string,
): Promise<void> {
  await sendMessageTelegram(String(params.chatId), text, {
    cfg: params.cfg,
    token: params.token,
    accountId: params.accountId,
    api: params.api,
    messageThreadId: params.threadId,
    replyToMessageId: params.messageId,
  });
}

async function captureAdbScreenshot(): Promise<{ ok: true; path: string } | { ok: false }> {
  return await new Promise((resolve) => {
    const child = spawn("adb", ["exec-out", "screencap", "-p"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let done = false;
    const outPath = path.join(
      os.tmpdir(),
      `telegram-benchmark-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`,
    );

    const timer = setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve({ ok: false });
    }, SCREENSHOT_TIMEOUT_MS);

    child.on("error", () => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve({ ok: false });
    });

    child.stdout.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    child.on("close", (code) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      if (code !== 0 || chunks.length === 0) {
        resolve({ ok: false });
        return;
      }
      try {
        fs.writeFileSync(outPath, Buffer.concat(chunks));
        resolve({ ok: true, path: outPath });
      } catch {
        resolve({ ok: false });
      }
    });
  });
}

export async function announceTelegramTaskStarted(params: TelegramBenchmarkNoticeParams) {
  taskStartTimes.set(buildTaskKey(params), Date.now());
  pruneTrackedTasks();
  await sendBenchmarkText(params, "[benchmark] inbound_received\nTask started");
}

export async function announceTelegramTaskCompleted(params: TelegramBenchmarkNoticeParams) {
  const taskKey = buildTaskKey(params);
  const startedAtMs = taskStartTimes.get(taskKey);
  taskStartTimes.delete(taskKey);

  await sendBenchmarkText(params, "[benchmark] reply_delivered\nTask completed");

  if (typeof startedAtMs === "number") {
    await sendBenchmarkText(
      params,
      `[benchmark] Execution time: ${formatDurationMs(Math.max(0, Date.now() - startedAtMs))}`,
    );
  }

  const screenshot = await captureAdbScreenshot();
  if (!screenshot.ok) {
    await sendBenchmarkText(params, "[benchmark] Screenshot failed");
    return;
  }

  try {
    await sendMessageTelegram(String(params.chatId), "[benchmark] Screenshot after task completion", {
      cfg: params.cfg,
      token: params.token,
      accountId: params.accountId,
      api: params.api,
      messageThreadId: params.threadId,
      replyToMessageId: params.messageId,
      mediaUrl: screenshot.path,
    });
  } finally {
    try {
      fs.unlinkSync(screenshot.path);
    } catch {}
  }
}