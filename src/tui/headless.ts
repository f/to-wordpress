import chalk, { type ChalkInstance } from "chalk";
import {
  type UiBus,
  type LogEntry,
  type EtaUpdate,
  type MigrationSummary,
} from "./bus.js";
import type { PhaseId, PhaseStatus, LoopStatusEvent } from "../types.js";
import { PHASE_TITLES } from "./bus.js";
import { formatDuration } from "../phases/eta.js";

/**
 * Non-TTY logger. Subscribes to the UiBus and writes human-readable lines to
 * stdout. Uses the `delta` field on streaming LogEntries for reliable
 * incremental output instead of reverse-engineering deltas from cumulative text.
 */
const WP_BLUE = chalk.hex("#21759B");

export function attachHeadlessLogger(bus: UiBus, sourceDir: string): () => void {
  process.stdout.write(WP_BLUE.bold("to  wordpress") + "  " + chalk.italic("· Code is Poetry.") + "\n");
  process.stdout.write(chalk.dim("manuscript: ") + sourceDir + "\n");

  let liveId: number | null = null;
  const closeLive = () => {
    if (liveId !== null) {
      process.stdout.write("\n");
      liveId = null;
    }
  };

  const onPhase = (id: PhaseId, status: PhaseStatus, message?: string) => {
    closeLive();
    const glyph = statusGlyph(status);
    const color = statusColor(status);
    const line = `${color(glyph)} ${color(PHASE_TITLES[id])}${message ? "  " + chalk.dim(message) : ""}`;
    process.stdout.write(line + "\n");
  };

  const onLog = (entry: LogEntry) => {
    if (entry.kind === "raw" || entry.kind === "stderr") return;
    const isStreaming = entry.kind === "assistant" || entry.kind === "reasoning";
    const prefix = entry.phase ? chalk.dim(`[${entry.phase}] `) : "";

    if (!isStreaming) {
      closeLive();
      process.stdout.write(prefix + colorize(entry.kind, entry.text) + "\n");
      return;
    }

    // Use the delta field when available for clean incremental output
    if (entry.delta !== undefined) {
      if (liveId === null) {
        process.stdout.write(prefix);
      } else if (entry.id !== liveId) {
        // New stream segment — no newline needed, just continue
      }
      process.stdout.write(colorize(entry.kind, entry.delta));
      liveId = entry.id;
      return;
    }

    // Fallback for entries without delta: write full text on new line
    closeLive();
    process.stdout.write(prefix + colorize(entry.kind, entry.text));
    liveId = entry.id;
  };

  const onLoopStatus = (ls: LoopStatusEvent) => {
    closeLive();
    const parts: string[] = [
      `${PHASE_TITLES[ls.phase]}`,
      `attempt ${ls.attempt}/${ls.maxAttempts}`,
    ];
    if (ls.fixPass > 0) parts.push(`fix ${ls.fixPass}/${ls.maxFixPasses}`);
    parts.push(ls.stage);
    process.stdout.write(chalk.cyan("⟳ " + parts.join(" · ")) + "\n");
  };

  let lastSummary: MigrationSummary | null = null;
  const onSummary = (s: MigrationSummary) => {
    lastSummary = s;
  };

  const onDone = (exitCode: number) => {
    closeLive();
    if (exitCode === 0) {
      process.stdout.write(
        "\n" + chalk.green.bold("✦ The volume is bound. Your WordPress stands ready for its readers.") + "\n",
      );
      if (lastSummary) {
        const pad = (k: string, v: string) =>
          chalk.dim("  " + k.padEnd(10)) + WP_BLUE.bold(v);
        process.stdout.write(
          "\n" +
            chalk.green("  ┌──────────────────────────────────────────────────────┐") +
            "\n" +
            chalk.green("  │  ") +
            chalk.bold("Migration complete — copy these before closing.") +
            chalk.green("     │") +
            "\n" +
            chalk.green("  └──────────────────────────────────────────────────────┘") +
            "\n",
        );
        process.stdout.write(pad("Site:", lastSummary.siteUrl) + "\n");
        process.stdout.write(pad("Admin:", lastSummary.adminUrl) + "\n");
        process.stdout.write(pad("User:", lastSummary.adminUser) + "\n");
        process.stdout.write(pad("Pass:", lastSummary.adminPassword) + "\n");
        process.stdout.write(chalk.dim("  " + "Source:".padEnd(10)) + lastSummary.sourceDir + "\n");
        process.stdout.write(
          chalk.dim(
            `  Took ${formatDuration(lastSummary.durationSeconds)}. \`npx wp-env stop\` pauses the stack; \`npx wp-env start\` resumes.`,
          ) + "\n",
        );
      }
    } else {
      process.stdout.write(chalk.red.bold(`✖ The press fell silent — exit code ${exitCode}.\n`));
    }
  };

  const onEta = (u: EtaUpdate) => {
    closeLive();
    const body = `verse: full ${formatDuration(u.totalSeconds)} · lines to go ${formatDuration(u.remainingSeconds)}${u.active ? " · now writing " + PHASE_TITLES[u.active] : ""}`;
    process.stdout.write(WP_BLUE.dim(body) + "\n");
  };

  bus.on("phase", onPhase);
  bus.on("log", onLog);
  bus.on("loop_status", onLoopStatus);
  bus.on("summary", onSummary);
  bus.on("done", onDone);
  bus.on("eta", onEta);

  return () => {
    bus.off("phase", onPhase);
    bus.off("log", onLog);
    bus.off("loop_status", onLoopStatus);
    bus.off("summary", onSummary);
    bus.off("done", onDone);
    bus.off("eta", onEta);
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
