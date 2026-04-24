import type { CopilotEvent } from "../types.js";

export type AgentKind = "claude" | "copilot" | "codex";

/**
 * Unified options for any supported agent. Some fields (`reasoning`,
 * `reasoningEffort`, `mode`) are Copilot-specific and ignored by
 * agents that don't support them.
 */
export interface AgentRunOptions {
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
  /**
   * Which agent CLI to use. Defaults to `TOWP_AGENT` env var
   * (`claude`, `copilot`, or `codex`), or `"claude"` if unset.
   */
  agent?: AgentKind;
}

export interface AgentRunResult {
  exitCode: number;
  sessionId?: string;
  assistantText: string;
}

/**
 * Each supported agent plugs in an `AgentSpec`: the binary to spawn,
 * how to build its CLI args from the unified options, and how to turn
 * its JSONL output into the shared `CopilotEvent[]` stream the TUI and
 * phases consume.
 */
export interface AgentSpec {
  readonly kind: AgentKind;
  readonly binary: string;
  readonly defaultModel: string;
  buildArgs(opts: AgentRunOptions): string[];
  parseLine(line: string): CopilotEvent[];
}

// Legacy alias — some call sites still use the older names. Prefer
// AgentRunOptions / AgentRunResult in new code.
export type CopilotRunOptions = AgentRunOptions;
export type CopilotRunResult = AgentRunResult;
