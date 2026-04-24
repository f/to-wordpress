import type { CopilotEvent } from "../types.js";
import type { AgentRunOptions, AgentSpec } from "./types.js";

/**
 * Codex model to pass via `--model`. Only emitted when explicitly set
 * via `CODEX_MODEL` env var or `--model` flag — otherwise codex uses
 * its own default (from `~/.codex/config.toml` or the user's plan),
 * which avoids the "model not supported for your account" error some
 * hard-coded names trigger on ChatGPT accounts.
 */
export const DEFAULT_CODEX_MODEL = process.env.CODEX_MODEL ?? "";

/**
 * Build CLI args for OpenAI's Codex CLI.
 *
 * Codex uses a subcommand structure: `codex exec` for a new session,
 * `codex exec resume <session-id>` to continue one. The prompt is
 * passed as the final positional argument. `--json` emits JSONL events;
 * `--dangerously-bypass-approvals-and-sandbox` mirrors Copilot's
 * `--allow-all-tools` and Claude's `--dangerously-skip-permissions`.
 */
export function buildCodexArgs(opts: AgentRunOptions): string[] {
  const args: string[] = ["exec"];
  if (opts.resumeSessionId) {
    args.push("resume", opts.resumeSessionId);
  }
  args.push(
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
  );
  const model = opts.model ?? DEFAULT_CODEX_MODEL;
  if (model) args.push("--model", model);
  if (opts.addDirs) {
    for (const d of opts.addDirs) args.push("--add-dir", d);
  }
  if (opts.extraArgs) args.push(...opts.extraArgs);
  // Codex takes the prompt as a positional argument at the end.
  args.push(opts.prompt);
  return args;
}

/**
 * Parse a single JSONL line from `codex exec --json`.
 *
 * Codex emits a relatively flat event stream — no fine-grained deltas,
 * just `thread.started`, `turn.started/completed`, and `item.started/
 * completed` wrappers around typed items. Known item types:
 *
 *   - `agent_message`       → assistant reply (full text, no deltas)
 *   - `reasoning`           → model reasoning summary (when available)
 *   - `command_execution`   → shell command tool use + result
 *   - `file_change`         → file edit tool use + result
 *
 * Unknown item types fall through to a generic tool_use/tool_result
 * pair so the TUI still shows activity.
 */
export function parseCodexLine(line: string): CopilotEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ type: "stdout", line }];
  }

  const events: CopilotEvent[] = [];
  const obj = parsed as Record<string, unknown>;
  const type = String(obj.type ?? "");

  // Session init — codex uses the term "thread".
  if (type === "thread.started") {
    if (typeof obj.thread_id === "string") {
      events.push({ type: "session", sessionId: obj.thread_id });
    }
    return events;
  }

  // Turn markers are purely informational; swallow them.
  if (type === "turn.started" || type === "turn.completed") {
    return events;
  }

  // Errors surfaced by codex itself.
  if (type === "error" || type === "error.generic") {
    events.push({
      type: "error",
      message: String(obj.message ?? obj.error ?? "unknown error"),
    });
    return events;
  }

  if (type !== "item.started" && type !== "item.completed") {
    return events;
  }

  const item = (obj.item ?? {}) as Record<string, unknown>;
  const itemType = String(item.type ?? "");
  const itemId = typeof item.id === "string" ? item.id : undefined;
  const isStart = type === "item.started";
  const isDone = type === "item.completed";

  switch (itemType) {
    case "agent_message": {
      // Codex only emits this as completed (no streaming deltas).
      if (!isDone) return events;
      const text = typeof item.text === "string" ? item.text : "";
      if (text) events.push({ type: "message", role: "assistant", text });
      return events;
    }

    case "reasoning": {
      if (!isDone) return events;
      const text =
        typeof item.text === "string"
          ? item.text
          : typeof item.summary === "string"
            ? item.summary
            : "";
      if (text) events.push({ type: "reasoning", text });
      return events;
    }

    case "command_execution": {
      if (isStart) {
        const command = typeof item.command === "string" ? item.command : "";
        events.push({
          type: "tool_use",
          name: "shell",
          input: { command },
          id: itemId,
        });
      } else if (isDone) {
        const output =
          typeof item.aggregated_output === "string"
            ? item.aggregated_output
            : (item.output ?? "");
        const exitCode =
          typeof item.exit_code === "number" ? item.exit_code : 0;
        const status = typeof item.status === "string" ? item.status : "";
        events.push({
          type: "tool_result",
          name: "shell",
          id: itemId,
          output,
          isError: exitCode !== 0 || status === "failed",
        });
      }
      return events;
    }

    case "file_change":
    case "patch_apply":
    case "edit":
    case "write": {
      if (isStart) {
        events.push({
          type: "tool_use",
          name: itemType,
          input: item,
          id: itemId,
        });
      } else if (isDone) {
        events.push({
          type: "tool_result",
          name: itemType,
          id: itemId,
          output: item,
          isError: item.status === "failed",
        });
      }
      return events;
    }

    default: {
      // Future-proof: surface any other item type as generic tool activity
      // so the user at least sees it in the log.
      if (isStart) {
        events.push({
          type: "tool_use",
          name: itemType || "item",
          input: item,
          id: itemId,
        });
      } else if (isDone) {
        events.push({
          type: "tool_result",
          name: itemType || "item",
          id: itemId,
          output: item,
          isError: item.status === "failed",
        });
      }
      return events;
    }
  }
}

export const codexSpec: AgentSpec = {
  kind: "codex",
  binary: "codex",
  defaultModel: DEFAULT_CODEX_MODEL,
  buildArgs: buildCodexArgs,
  parseLine: parseCodexLine,
};
