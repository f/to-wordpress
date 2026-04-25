import { execa, type ExecaError } from "execa";
import type { CopilotEvent } from "../types.js";
import type {
  AgentKind,
  AgentRunOptions,
  AgentRunResult,
  AgentSpec,
} from "./types.js";
import { copilotSpec, normalizeCopilotModel } from "./copilot.js";
import { claudeSpec } from "./claude.js";
import { codexSpec } from "./codex.js";

export type { AgentKind, AgentRunOptions, AgentRunResult, AgentSpec, CopilotRunOptions, CopilotRunResult } from "./types.js";
export {
  buildCopilotArgs,
  normalizeCopilotModel,
  parseCopilotLine,
  copilotSpec,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_COPILOT_EFFORT,
} from "./copilot.js";
export {
  buildClaudeArgs,
  parseClaudeLine,
  claudeSpec,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_EFFORT,
} from "./claude.js";
export {
  buildCodexArgs,
  parseCodexLine,
  codexSpec,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_EFFORT,
} from "./codex.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const SPECS: Record<AgentKind, AgentSpec> = {
  copilot: copilotSpec,
  claude: claudeSpec,
  codex: codexSpec,
};

function parseAgentEnv(value: string | undefined): AgentKind {
  if (value === "claude" || value === "codex" || value === "copilot") return value;
  return "claude";
}

/**
 * Default agent resolved from env. Individual `runAgent` calls can
 * still override via `opts.agent`, and `resolveAgent` re-reads the env
 * every time so the `--agent` CLI flag (which sets TOWP_AGENT after
 * this module is imported) still takes effect for every phase.
 */
export const DEFAULT_AGENT: AgentKind = parseAgentEnv(process.env.TOWP_AGENT);

function resolveAgent(opts: AgentRunOptions): AgentKind {
  if (opts.agent) return opts.agent;
  return parseAgentEnv(process.env.TOWP_AGENT);
}

export function specFor(agent: AgentKind): AgentSpec {
  return SPECS[agent];
}

/**
 * Merge two async line iterators into a single stream of CopilotEvents.
 */
async function* mergeStreams(
  stdoutLines: AsyncGenerator<string>,
  stderrLines: AsyncGenerator<string>,
  spec: AgentSpec,
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
        queue.push(spec.parseLine(line));
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
 * Spawn the selected agent CLI (`copilot` or `claude`) and yield a
 * unified stream of CopilotEvents. Behavior differs only in which
 * binary/args/parser are used; downstream consumers are agent-agnostic.
 */
export async function* runAgent(
  opts: AgentRunOptions,
  signal?: AbortSignal,
): AsyncGenerator<CopilotEvent, AgentRunResult, void> {
  const agent = resolveAgent(opts);
  const spec = SPECS[agent];
  const args = spec.buildArgs(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const child = execa(spec.binary, args, {
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
    spec,
  );

  for await (const ev of merged) {
    if (ev.type === "session") sessionId = ev.sessionId;
    if (ev.type === "message" && ev.role === "assistant") {
      assistantText += ev.text;
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

/** Legacy alias. Prefer {@link runAgent} in new code. */
export const runCopilot = runAgent;

/**
 * Convenience: run an agent to completion, collecting events through a
 * callback.
 */
export async function runAgentToEnd(
  opts: AgentRunOptions,
  onEvent?: (ev: CopilotEvent) => void,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  const iter = runAgent(opts, signal);
  let final: AgentRunResult = { exitCode: 0, assistantText: "" };
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

/** Legacy alias. */
export const runCopilotToEnd = runAgentToEnd;

/** Exports for tests / introspection. */
export const __testables = {
  buildCopilotArgs: copilotSpec.buildArgs,
  buildClaudeArgs: claudeSpec.buildArgs,
  buildCodexArgs: codexSpec.buildArgs,
  normalizeCopilotModel,
  parseCopilotLine: copilotSpec.parseLine,
  parseClaudeLine: claudeSpec.parseLine,
  parseCodexLine: codexSpec.parseLine,
};
