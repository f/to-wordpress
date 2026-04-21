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
  /** Stream reasoning summaries from the model (on by default for visibility). */
  reasoning?: boolean;
  /** Reasoning effort for supported models. */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

export interface CopilotRunResult {
  exitCode: number;
  sessionId?: string;
  assistantText: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Default Copilot model for every creative phase. Opus is our reasoning
 * workhorse; paired with medium reasoning effort it's the sweet spot of
 * quality vs. latency for Liquid-to-PHP translation, custom-block generation,
 * and the verify fix loop. Override with --model <slug>, COPILOT_MODEL, or
 * --effort / COPILOT_EFFORT.
 *
 * NOTE: Copilot CLI model slugs are family-only (e.g. `claude-opus-4.7`);
 * effort is a separate `--effort` flag, not a suffix.
 */
export const DEFAULT_COPILOT_MODEL =
  process.env.COPILOT_MODEL ?? "claude-opus-4.7";

export const DEFAULT_COPILOT_EFFORT: "low" | "medium" | "high" | "xhigh" =
  (process.env.COPILOT_EFFORT as "low" | "medium" | "high" | "xhigh" | undefined) ?? "medium";

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
  // Request reasoning summaries from the underlying model so the TUI can
  // render a live "thinking" stream. Default on; callers can opt out.
  if (opts.reasoning !== false) {
    args.push("--enable-reasoning-summaries");
  }
  args.push("--effort", opts.reasoningEffort ?? DEFAULT_COPILOT_EFFORT);
  if (opts.extraArgs) args.push(...opts.extraArgs);
  return args;
}

/**
 * Parse a single JSONL line emitted by `copilot -p --output-format json` and
 * normalize it into one or more CopilotEvent values. Copilot's event shape is
 * still evolving; we defensively fan-out on any known discriminators and
 * always emit a raw `stdout` event so the TUI can display everything.
 */
function parseCopilotLine(line: string): CopilotEvent[] {
  const events: CopilotEvent[] = [];
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(line);
  } catch {
    events.push({ type: "stdout", line });
    return events;
  }
  events.push({ type: "stdout", line, raw: parsed });

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

  // Reasoning summaries come from the model under many event names. Copilot
  // CLI today emits `assistant.reasoning_delta` / `assistant.reasoning` with
  // the payload on `data.deltaContent` / `data.content`. We stay permissive
  // so the TUI's third column keeps working if the wire format shifts.
  const lowerKind = kind.toLowerCase();
  if (/reason|think/.test(lowerKind)) {
    const data = (obj.data ?? {}) as Record<string, unknown>;
    const text = extractText(
      data.deltaContent ??
        data.delta_content ??
        data.content ??
        data.text ??
        data.summary ??
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
  // Fallback: some shapes put reasoning under a top-level `reasoning`
  // property regardless of the event `type`. Grab it if we haven't already
  // produced a reasoning event above.
  const reasoningField = obj.reasoning ?? obj.thinking;
  if (reasoningField) {
    const text = extractText(reasoningField);
    if (text) events.push({ type: "reasoning", text });
  }

  // Copilot CLI today emits dotted event names and stuffs the real payload
  // onto `data.*`. We dispatch on the dotted names first, then fall back to
  // the older flat shapes we originally targeted so downstream tooling keeps
  // working on either wire format.
  const data = (obj.data ?? {}) as Record<string, unknown>;

  switch (kind) {
    case "assistant.message":
    case "assistant.message_delta":
    case "message":
    case "assistant_message":
    case "assistant": {
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

/**
 * Spawn `copilot -p …` and return an async iterable of CopilotEvents.
 * The child is killed when the iterator is abandoned or `signal` is aborted.
 */
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

  const stderrLines = readLines(child.stderr!);
  const stdoutLines = readLines(child.stdout!);

  const stderrPump = (async () => {
    const events: CopilotEvent[] = [];
    for await (const line of stderrLines) {
      events.push({ type: "stderr", line });
    }
    return events;
  })();

  try {
    for await (const line of stdoutLines) {
      const events = parseCopilotLine(line);
      for (const ev of events) {
        if (ev.type === "session") sessionId = ev.sessionId;
        if (ev.type === "message" && ev.role === "assistant") {
          assistantText += (assistantText ? "\n" : "") + ev.text;
        }
        yield ev;
      }
    }
  } catch (err) {
    yield { type: "error", message: (err as Error).message };
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

  const stderrEvents = await stderrPump;
  for (const ev of stderrEvents) yield ev;

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

/**
 * Convenience: run copilot to completion, collecting events into a single result.
 */
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
