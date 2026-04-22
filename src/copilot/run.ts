import { execa, type ExecaError } from "execa";
import type { CopilotEvent } from "../types.js";

export interface CopilotRunOptions {
  prompt: string;
  cwd: string;
  addDirs?: string[];
  allowTools?: string[];
  denyTools?: string[];
  model?: string;
  resumeSessionId?: string;
  maxAutopilotContinues?: number;
  timeoutMs?: number;
  extraArgs?: string[];
  mode?: "autopilot" | "plan" | "interactive";
  env?: Record<string, string>;
  reasoning?: boolean;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

export interface CopilotRunResult {
  exitCode: number;
  sessionId?: string;
  assistantText: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export const DEFAULT_COPILOT_MODEL = process.env.COPILOT_MODEL ?? "gpt-5.4";

export const DEFAULT_COPILOT_EFFORT: "low" | "medium" | "high" | "xhigh" =
  (process.env.COPILOT_EFFORT as "low" | "medium" | "high" | "xhigh" | undefined) ?? "high";

function buildArgs(opts: CopilotRunOptions): string[] {
  const args: string[] = [
    "-p",
    opts.prompt,
    "--output-format",
    "json",
    "--stream",
    "on",
    "--allow-all-tools",
    "--no-ask-user",
    "--mode",
    opts.mode ?? "autopilot",
  ];
  if (opts.addDirs) {
    for (const d of opts.addDirs) args.push("--add-dir", d);
  }
  if (opts.allowTools && opts.allowTools.length > 0) {
    args.push(`--allow-tool=${opts.allowTools.join(",")}`);
  }
  if (opts.denyTools && opts.denyTools.length > 0) {
    args.push(`--deny-tool=${opts.denyTools.join(",")}`);
  }
  args.push("--model", opts.model ?? DEFAULT_COPILOT_MODEL);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (typeof opts.maxAutopilotContinues === "number") {
    args.push("--max-autopilot-continues", String(opts.maxAutopilotContinues));
  }
  if (opts.reasoning !== false) {
    args.push("--enable-reasoning-summaries");
  }
  args.push("--effort", opts.reasoningEffort ?? DEFAULT_COPILOT_EFFORT);
  if (opts.extraArgs) args.push(...opts.extraArgs);
  return args;
}

/**
 * Parse a single JSONL line from `copilot --output-format json` into
 * CopilotEvent values. Only emits a raw `stdout` fallback when the line
 * cannot be parsed as JSON at all — structured events never emit a
 * duplicate `stdout` alongside them.
 */
function parseCopilotLine(line: string): CopilotEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ type: "stdout", line }];
  }

  const events: CopilotEvent[] = [];
  const obj = parsed as Record<string, unknown>;
  const kind =
    (obj.type as string | undefined) ?? (obj.event as string | undefined) ?? "";

  const sessionId =
    (obj.session_id as string | undefined) ??
    (obj.sessionId as string | undefined) ??
    (typeof obj.session === "object" && obj.session && (obj.session as Record<string, unknown>).id
      ? ((obj.session as Record<string, unknown>).id as string)
      : undefined);
  if (sessionId) events.push({ type: "session", sessionId });

  const lowerKind = kind.toLowerCase();
  if (/reason|think/.test(lowerKind)) {
    const isDelta = /delta/.test(lowerKind);
    if (!isDelta) return events;
    const reasoningData = (obj.data ?? {}) as Record<string, unknown>;
    const text = extractText(
      reasoningData.deltaContent ??
        reasoningData.delta_content ??
        reasoningData.content ??
        reasoningData.text ??
        reasoningData.summary ??
        obj.content ??
        obj.text ??
        obj.summary ??
        obj.delta ??
        obj.value ??
        obj.thought,
    );
    if (text) {
      events.push({ type: "reasoning", text });
      return events;
    }
  }

  const reasoningField = obj.reasoning ?? obj.thinking;
  if (reasoningField) {
    const text = extractText(reasoningField);
    if (text) events.push({ type: "reasoning", text });
  }

  const data = (obj.data ?? {}) as Record<string, unknown>;

  switch (kind) {
    case "assistant.message":
    case "assistant.message_delta":
    case "message":
    case "assistant_message":
    case "assistant": {
      const isDelta = /delta/.test(kind.toLowerCase());
      const isConsolidation = kind.startsWith("assistant.") && !isDelta;
      if (isConsolidation) break;
      const role = ((obj.role as string | undefined) ?? (data.role as string | undefined) ?? "assistant") as
        | "assistant"
        | "user"
        | "system";
      const text = extractText(
        data.deltaContent ??
          data.delta_content ??
          data.content ??
          obj.content ??
          obj.text ??
          obj.message,
      );
      if (text) events.push({ type: "message", role, text });
      break;
    }
    case "tool.execution_start":
    case "tool_use":
    case "tool_call": {
      events.push({
        type: "tool_use",
        name: String(data.toolName ?? data.name ?? obj.name ?? obj.tool ?? "tool"),
        input: data.arguments ?? data.input ?? obj.input ?? obj.arguments ?? obj.args,
        id: (data.toolCallId as string | undefined) ?? (obj.id as string | undefined),
      });
      break;
    }
    case "tool.execution_complete":
    case "tool_result":
    case "tool_output": {
      const result = (data.result ?? {}) as Record<string, unknown>;
      events.push({
        type: "tool_result",
        name: (data.toolName as string | undefined) ?? (obj.name as string | undefined),
        output:
          result.content ??
          result.detailedContent ??
          data.output ??
          obj.output ??
          obj.result ??
          obj.content,
        id: (data.toolCallId as string | undefined) ?? (obj.id as string | undefined),
        isError:
          data.success === false ||
          Boolean(obj.is_error ?? obj.isError),
      });
      break;
    }
    case "error":
    case "session.error": {
      events.push({
        type: "error",
        message: String(
          data.message ?? data.error ?? obj.message ?? obj.error ?? "unknown error",
        ),
      });
      break;
    }
    default: {
      const text = extractText(
        data.content ?? data.text ?? obj.content ?? obj.text ?? obj.message,
      );
      if (text && !kind) events.push({ type: "message", role: "assistant", text });
    }
  }
  return events;
}

function extractText(content: unknown): string | undefined {
  if (!content) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const obj = c as Record<string, unknown>;
          if (typeof obj.text === "string") return obj.text;
          if (typeof obj.value === "string") return obj.value;
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.value === "string") return obj.value;
  }
  return undefined;
}

async function* mergeStreams(
  stdoutLines: AsyncGenerator<string>,
  stderrLines: AsyncGenerator<string>,
): AsyncGenerator<CopilotEvent> {
  type QueueItem = CopilotEvent[];
  const queue: QueueItem[] = [];
  let done = 0;
  let waiting: ((value: void) => void) | null = null;

  const signal = () => {
    if (waiting) {
      waiting(undefined);
      waiting = null;
    }
  };

  const pumpStdout = (async () => {
    try {
      for await (const line of stdoutLines) {
        queue.push(parseCopilotLine(line));
        signal();
      }
    } catch (err) {
      queue.push([{ type: "error", message: (err as Error).message }]);
      signal();
    }
    done++;
    signal();
  })();

  const pumpStderr = (async () => {
    try {
      for await (const line of stderrLines) {
        queue.push([{ type: "stderr", line }]);
        signal();
      }
    } catch {
      // stderr read errors are non-fatal
    }
    done++;
    signal();
  })();

  while (done < 2 || queue.length > 0) {
    if (queue.length === 0) {
      if (done >= 2) break;
      await new Promise<void>((r) => { waiting = r; });
      continue;
    }
    const batch = queue.shift()!;
    for (const ev of batch) yield ev;
  }

  await Promise.allSettled([pumpStdout, pumpStderr]);
}

export async function* runCopilot(
  opts: CopilotRunOptions,
  signal?: AbortSignal,
): AsyncGenerator<CopilotEvent, CopilotRunResult, void> {
  const args = buildArgs(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const child = execa("copilot", args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}), FORCE_COLOR: "0" },
    reject: false,
    buffer: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });

  signal?.addEventListener("abort", () => {
    child.kill("SIGTERM");
  });

  let sessionId: string | undefined;
  let assistantText = "";

  const merged = mergeStreams(
    readLines(child.stdout!),
    readLines(child.stderr!),
  );

  for await (const ev of merged) {
    if (ev.type === "session") sessionId = ev.sessionId;
    if (ev.type === "message" && ev.role === "assistant") {
      assistantText += (assistantText ? "\n" : "") + ev.text;
    }
    yield ev;
  }

  let exitCode = 0;
  try {
    const result = await child;
    exitCode = result.exitCode ?? 0;
  } catch (err) {
    const e = err as ExecaError;
    exitCode = e.exitCode ?? 1;
    yield { type: "error", message: e.shortMessage ?? e.message };
  }

  yield { type: "done", exitCode };

  return { exitCode, sessionId, assistantText };
}

async function* readLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) yield line;
    }
  }
  const rest = buffer.trim();
  if (rest.length > 0) yield rest;
}

export async function runCopilotToEnd(
  opts: CopilotRunOptions,
  onEvent?: (ev: CopilotEvent) => void,
  signal?: AbortSignal,
): Promise<CopilotRunResult> {
  const iter = runCopilot(opts, signal);
  let final: CopilotRunResult = { exitCode: 0, assistantText: "" };
  while (true) {
    const next = await iter.next();
    if (next.value && !next.done) onEvent?.(next.value);
    if (next.done) {
      final = next.value;
      break;
    }
  }
  return final;
}
