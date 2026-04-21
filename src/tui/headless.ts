import chalk, { type ChalkInstance } from "chalk";
import type { UiBus, LogEntry, PromptRequest } from "./bus.js";
import type { PhaseId, PhaseStatus } from "../types.js";
import { PHASE_TITLES } from "./bus.js";

/**
 * Non-TTY logger. Subscribes to the UiBus and writes human-readable lines to
 * stdout. Used when stdin is not a TTY (CI, pipes), or when a user passes
 * --no-tui. Prompts are auto-answered by bus.autoAnswer upstream.
 */
export function attachHeadlessLogger(bus: UiBus, sourceDir: string): () => void {
  process.stdout.write(chalk.cyan.bold("to-wordpress") + "  source=" + sourceDir + "\n");

  const onPhase = (id: PhaseId, status: PhaseStatus, message?: string) => {
    const glyph = statusGlyph(status);
    const color = statusColor(status);
    const line = `${color(glyph)} ${color(PHASE_TITLES[id])}${message ? "  " + chalk.dim(message) : ""}`;
    process.stdout.write(line + "\n");
  };

  const onLog = (entry: LogEntry) => {
    if (entry.kind === "raw" || entry.kind === "stderr") return;
    const prefix = entry.phase ? chalk.dim(`[${entry.phase}] `) : "";
    const body = colorize(entry.kind, entry.text);
    process.stdout.write(prefix + body + "\n");
  };

  const onPrompt = (req: PromptRequest) => {
    process.stdout.write(chalk.yellow(`? ${req.title}: ${req.message}`) + "\n");
  };

  const onDone = (exitCode: number) => {
    if (exitCode === 0) process.stdout.write(chalk.green.bold("✔ migration complete\n"));
    else process.stdout.write(chalk.red.bold(`✖ migration exited with code ${exitCode}\n`));
  };

  bus.on("phase", onPhase);
  bus.on("log", onLog);
  bus.on("prompt:request", onPrompt);
  bus.on("done", onDone);

  return () => {
    bus.off("phase", onPhase);
    bus.off("log", onLog);
    bus.off("prompt:request", onPrompt);
    bus.off("done", onDone);
  };
}

function statusGlyph(s: PhaseStatus): string {
  switch (s) {
    case "pending":
      return "○";
    case "running":
      return "▶";
    case "ok":
      return "✔";
    case "fail":
      return "✖";
    case "skipped":
      return "—";
  }
}

function statusColor(s: PhaseStatus): ChalkInstance {
  switch (s) {
    case "pending":
      return chalk.gray;
    case "running":
      return chalk.cyan;
    case "ok":
      return chalk.green;
    case "fail":
      return chalk.red;
    case "skipped":
      return chalk.yellow;
  }
}

function colorize(kind: LogEntry["kind"], text: string): string {
  switch (kind) {
    case "assistant":
      return chalk.green(text);
    case "reasoning":
      return chalk.magenta.dim(text);
    case "tool":
      return chalk.cyan("› " + text);
    case "tool_result":
      return chalk.blue("‹ " + text);
    case "error":
      return chalk.red(text);
    case "warn":
      return chalk.yellow(text);
    default:
      return text;
  }
}
