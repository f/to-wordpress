import type { CopilotEvent } from "../types.js";
import type { AgentRunOptions, AgentSpec } from "./types.js";
import { extractText } from "./shared.js";

export const DEFAULT_COPILOT_MODEL = process.env.COPILOT_MODEL ?? "claude-opus-4.7";

export const DEFAULT_COPILOT_EFFORT: "low" | "medium" | "high" | "xhigh" =
  (process.env.COPILOT_EFFORT as "low" | "medium" | "high" | "xhigh" | undefined) ?? "high";

/**
 * Build CLI args for the GitHub Copilot CLI. Copilot uses a mix of dashed
 * flags and equals-style flags for allow/deny lists; streaming is enabled
 * by passing `--output-format json --stream on`.
 */
export function buildCopilotArgs(opts: AgentRunOptions): string[] {
  const args: string[] = [
    "-p",
    opts.prompt,
    "--output-format",
    "json",
    "--stream",
    "on",
    "--allow-all-tools",
    "--no-ask-user",
  ];
  // Some Copilot CLI versions reject `--mode` even though newer builds
  // document it. `--autopilot` is the stable shorthand for the only mode
  // we use in unattended migrations, and omitting a mode still keeps
  // `-p` non-interactive.
  if ((opts.mode ?? "autopilot") === "autopilot") {
    args.push("--autopilot");
  }
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
 * Parse a single JSONL line emitted by `copilot --output-format json`.
 * Copilot's event shape is still evolving, so we defensively fan out on
 * known discriminators. Returns a raw `stdout` fallback only when the
 * line cannot be parsed as JSON.
 */
export function parseCopilotLine(line: string): CopilotEvent[] {
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

export const copilotSpec: AgentSpec = {
  kind: "copilot",
  binary: "copilot",
  defaultModel: DEFAULT_COPILOT_MODEL,
  buildArgs: buildCopilotArgs,
  parseLine: parseCopilotLine,
};
