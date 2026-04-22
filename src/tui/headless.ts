import chalk, { type ChalkInstance } from "chalk";
import {
  normalizeStreamDelta,
  type UiBus,
  type LogEntry,
  type PromptRequest,
  type EtaUpdate,
  type MigrationSummary,
} from "./bus.js";
import type { PhaseId, PhaseStatus } from "../types.js";
import { PHASE_TITLES } from "./bus.js";
import { formatDuration } from "../phases/eta.js";

/**
 * Non-TTY logger. Subscribes to the UiBus and writes human-readable lines to
 * stdout. Used when stdin is not a TTY (CI, pipes), or when a user passes
 * --no-tui. Prompts are auto-answered by bus.autoAnswer upstream.
 */
const WP_BLUE = chalk.hex("#21759B");

export function attachHeadlessLogger(bus: UiBus, sourceDir: string): () => void {
  process.stdout.write(WP_BLUE.bold("to  wordpress") + "  " + chalk.italic("· Code is Poetry.") + "\n");
  process.stdout.write(chalk.dim("manuscript: ") + sourceDir + "\n");

  // Coalesce live-streaming entries (assistant / reasoning). The bus
  // re-emits the same `id` with growing cumulative text on every delta,
  // but any interleaved tool call / info event resets the live stream,
  // so consecutive deltas frequently arrive as _different_ ids that
  // happen to belong to the same human "paragraph". We keep the
  // paragraph flowing on a single terminal line until a non-streaming
  // event (phase change, prompt, info, tool call) fires, at which point
  // we close the line with a newline before printing the new event.
  let liveId: number | null = null;
  let liveText = "";
  const closeLive = () => {
    if (liveId !== null) {
      process.stdout.write("\n");
      liveId = null;
      liveText = "";
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

    // Log entries mirror {@link UiBus} live streaming: same `id` means
    // cumulative `text` for that segment; a new `id` continues after a
    // tool call or wrap — use {@link normalizeStreamDelta} so we never
    // inject a spurious space between `WORD` and ` PRESS` (see bus).
    if (liveId === null) {
      process.stdout.write(prefix + colorize(entry.kind, entry.text));
      liveId = entry.id;
      liveText = entry.text;
      return;
    }

    if (entry.id === liveId) {
      const delta = entry.text.startsWith(liveText)
        ? entry.text.slice(liveText.length)
        : entry.text;
      if (!entry.text.startsWith(liveText)) {
        process.stdout.write("\n" + prefix + colorize(entry.kind, entry.text));
      } else if (delta) {
        process.stdout.write(colorize(entry.kind, delta));
      }
      liveText = entry.text;
      return;
    }

    const chunk = entry.text.startsWith(liveText)
      ? entry.text.slice(liveText.length)
      : normalizeStreamDelta(liveText, entry.text);
    process.stdout.write(colorize(entry.kind, chunk));
    liveId = entry.id;
    liveText = entry.text;
  };

  const onPrompt = (req: PromptRequest) => {
    closeLive();
    process.stdout.write(chalk.yellow(`? ${req.title}: ${req.message}`) + "\n");
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
  bus.on("prompt:request", onPrompt);
  bus.on("summary", onSummary);
  bus.on("done", onDone);
  bus.on("eta", onEta);

  return () => {
    bus.off("phase", onPhase);
    bus.off("log", onLog);
    bus.off("prompt:request", onPrompt);
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
