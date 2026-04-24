import type { CopilotEvent } from "../types.js";
import type { AgentRunOptions, AgentSpec } from "./types.js";

export const DEFAULT_CLAUDE_MODEL =
  process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5";

/**
 * Build CLI args for Anthropic's Claude Code CLI. `stream-json` requires
 * `--verbose`; `--include-partial-messages` enables fine-grained delta
 * events we translate into live message/reasoning updates.
 */
export function buildClaudeArgs(opts: AgentRunOptions): string[] {
  const args: string[] = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];
  if (opts.addDirs) {
    for (const d of opts.addDirs) args.push("--add-dir", d);
  }
  if (opts.allowTools && opts.allowTools.length > 0) {
    args.push("--allowed-tools", opts.allowTools.join(","));
  }
  if (opts.denyTools && opts.denyTools.length > 0) {
    args.push("--disallowed-tools", opts.denyTools.join(","));
  }
  args.push("--model", opts.model ?? DEFAULT_CLAUDE_MODEL);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (typeof opts.maxAutopilotContinues === "number") {
    args.push("--max-turns", String(opts.maxAutopilotContinues));
  }
  if (opts.extraArgs) args.push(...opts.extraArgs);
  return args;
}

/**
 * Parse a single line from `claude --output-format stream-json
 * --include-partial-messages`.
 *
 * Claude streams deltas inside `stream_event` wrappers, then emits a
 * consolidated `assistant` message at end of turn. We take
 * `text_delta` / `thinking_delta` for live output and `tool_use` from
 * the consolidated message (the partial `input` is only complete on
 * `message_stop`). Tool results arrive wrapped in `user` messages.
 */
export function parseClaudeLine(line: string): CopilotEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ type: "stdout", line }];
  }

  const events: CopilotEvent[] = [];
  const obj = parsed as Record<string, unknown>;
  const type = (obj.type as string | undefined) ?? "";

  // Session init carries the session id used later via --resume.
  if (type === "system") {
    if (obj.subtype === "init" && typeof obj.session_id === "string") {
      events.push({ type: "session", sessionId: obj.session_id });
    }
    return events;
  }

  // Streaming deltas: text + thinking.
  if (type === "stream_event") {
    const event = (obj.event ?? {}) as Record<string, unknown>;
    if (event.type === "content_block_delta") {
      const delta = (event.delta ?? {}) as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        events.push({ type: "message", role: "assistant", text: delta.text });
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        events.push({ type: "reasoning", text: delta.thinking });
      }
    }
    return events;
  }

  // Consolidated assistant turn: extract tool_use calls. We skip text
  // here — deltas already streamed it via stream_event.
  if (type === "assistant") {
    const message = (obj.message ?? {}) as Record<string, unknown>;
    const content = message.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const it = item as Record<string, unknown>;
        if (it.type === "tool_use") {
          events.push({
            type: "tool_use",
            name: String(it.name ?? "tool"),
            input: it.input ?? {},
            id: typeof it.id === "string" ? it.id : undefined,
          });
        }
      }
    }
    return events;
  }

  // Tool results arrive as a "user" message (Anthropic API convention).
  if (type === "user") {
    const message = (obj.message ?? {}) as Record<string, unknown>;
    const content = message.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const it = item as Record<string, unknown>;
        if (it.type === "tool_result") {
          events.push({
            type: "tool_result",
            id: typeof it.tool_use_id === "string" ? it.tool_use_id : undefined,
            output: it.content,
            isError: Boolean(it.is_error),
          });
        }
      }
    }
    return events;
  }

  // Final result — only surface as an event if Claude reports an error.
  // Success case is handled by the process exit path.
  if (type === "result") {
    if (obj.subtype && obj.subtype !== "success") {
      events.push({
        type: "error",
        message: String(obj.error ?? obj.result ?? "unknown error"),
      });
    }
    return events;
  }

  return events;
}

export const claudeSpec: AgentSpec = {
  kind: "claude",
  binary: "claude",
  defaultModel: DEFAULT_CLAUDE_MODEL,
  buildArgs: buildClaudeArgs,
  parseLine: parseClaudeLine,
};
