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
  if (opts.model) args.push("--model", opts.model);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (typeof opts.maxAutopilotContinues === "number") {
    args.push("--max-autopilot-continues", String(opts.maxAutopilotContinues));
  }
  // Request reasoning summaries from the underlying model so the TUI can
  // render a live "thinking" stream. Default on; callers can opt out.
  if (opts.reasoning !== false) {
    args.push("--enable-reasoning-summaries");
  }
  if (opts.reasoningEffort) {
    args.push("--effort", opts.reasoningEffort);
  }
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

  // Reasoning summaries come from the model under many event names. Be
  // permissive and surface any "thinking" shape so the TUI's third column
  // stays live regardless of which vendor Copilot is wrapping.
  const lowerKind = kind.toLowerCase();
  if (/reason|think/.test(lowerKind)) {
    const text = extractText(
      obj.content ?? obj.text ?? obj.summary ?? obj.delta ?? obj.value ?? obj.thought,
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

  switch (kind) {
    case "message":
    case "assistant_message":
    case "assistant": {
      const role = ((obj.role as string | undefined) ?? "assistant") as
        | "assistant"
        | "user"
        | "system";
      const content = obj.content ?? obj.text ?? obj.message;
      const text = extractText(content);
      if (text) events.push({ type: "message", role, text });
      break;
    }
    case "tool_use":
    case "tool_call": {
      events.push({
        type: "tool_use",
        name: String(obj.name ?? obj.tool ?? "tool"),
        input: obj.input ?? obj.arguments ?? obj.args,
        id: obj.id as string | undefined,
      });
      break;
    }
    case "tool_result":
    case "tool_output": {
      events.push({
        type: "tool_result",
        name: obj.name as string | undefined,
        output: obj.output ?? obj.result ?? obj.content,
        id: obj.id as string | undefined,
        isError: Boolean(obj.is_error ?? obj.isError),
      });
      break;
    }
    case "error": {
      events.push({
        type: "error",
        message: String(obj.message ?? obj.error ?? "unknown error"),
      });
      break;
    }
    default: {
      const text = extractText(obj.content ?? obj.text ?? obj.message);
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
