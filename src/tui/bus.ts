import { EventEmitter } from "node:events";
import type { PhaseId, PhaseStatus, StreamEvent } from "../types.js";

export interface PhaseSnapshot {
  id: PhaseId;
  title: string;
  status: PhaseStatus;
  startedAt?: number;
  finishedAt?: number;
  message?: string;
}

export type LogEntryKind =
  | "info"
  | "warn"
  | "error"
  | "assistant"
  | "reasoning"
  | "tool"
  | "tool_result"
  | "stderr"
  | "raw";

export interface LogEntry {
  id: number;
  ts: number;
  phase?: PhaseId;
  kind: LogEntryKind;
  text: string;
}

export interface EtaUpdate {
  totalSeconds: number;
  remainingSeconds: number;
  active?: PhaseId;
}

export interface PromptRequest {
  id: string;
  title: string;
  kind: "confirm" | "text" | "select";
  message: string;
  options?: Array<{ label: string; value: string }>;
  default?: string;
}

export interface PromptResponse {
  id: string;
  value: string;
}

type PendingKind = "assistant" | "reasoning";

interface LiveStream {
  id: number;
  phase: PhaseId | undefined;
  kind: PendingKind;
  text: string;
  ts: number;
}

/**
 * Maximum characters one live entry is allowed to grow before it "wraps"
 * into a fresh entry. Keeps any single rendered paragraph from becoming
 * arbitrarily large. 4 KB covers a few hundred words which is plenty of
 * live context — anything older scrolls off naturally.
 */
const LIVE_WRAP_CHARS = 4000;

export class UiBus extends EventEmitter {
  private logId = 0;
  /**
   * The currently live stream entry (if any). While a stream is active
   * the same LogEntry is re-emitted on every delta; the TUI replaces the
   * entry with the same id in-place so users see one continuously
   * growing line instead of a ladder of one-word rows.
   */
  private live: LiveStream | null = null;
  /**
   * Ring buffer of the last few hundred user-facing log lines. Used by
   * the per-phase repair flow so Copilot gets a tail of the run's
   * actual output when it's asked to diagnose a failure (the error
   * message on its own rarely tells the whole story).
   */
  private tail: Array<{ ts: number; phase: PhaseId | undefined; kind: string; text: string }> = [];
  private readonly TAIL_MAX = 400;
  autoAnswer = false;

  /**
   * Return the most recent {@link UiBus.TAIL_MAX} (or `n`, whichever is
   * smaller) log lines, optionally filtered by phase. Each line is
   * prefixed with its kind so a repair prompt reads like a log file.
   */
  recentLogs(n = 120, phase?: PhaseId): string {
    const src = phase ? this.tail.filter((t) => t.phase === phase) : this.tail;
    return src
      .slice(-n)
      .map((t) => `[${t.kind}] ${t.text}`)
      .join("\n");
  }

  pushStreamEvent(phase: PhaseId | undefined, ev: StreamEvent): void {
    this.emit("stream", phase, ev);

    // Copilot streams `message` and `reasoning` in sub-word deltas. Emit
    // them as updates to a single "live" LogEntry rather than separate
    // rows — that's the only way to avoid the ragged
    // "The / mirrored / theme / already / has" one-word ladder.
    if (ev.type === "message" || ev.type === "reasoning") {
      const text = ev.text ?? "";
      if (!text) return;
      const kind: PendingKind = ev.type === "message" ? "assistant" : "reasoning";

      const sameStream =
        this.live !== null &&
        this.live.kind === kind &&
        this.live.phase === phase;

      if (!sameStream) {
        // Finalize the previous live stream (just drop the reference —
        // it's already been emitted; nothing more to do) and begin a new
        // one with a fresh id.
        this.live = {
          id: ++this.logId,
          phase,
          kind,
          text: "",
          ts: Date.now(),
        };
      }

      // Append delta. If the live entry grows past the wrap limit, start
      // a new one so pane rendering stays cheap.
      this.live!.text += text;
      if (this.live!.text.length > LIVE_WRAP_CHARS) {
        this.emitLive();
        this.live = {
          id: ++this.logId,
          phase,
          kind,
          text: "",
          ts: Date.now(),
        };
      } else {
        this.emitLive();
      }
      return;
    }

    // Any non-stream event finalizes the live stream so subsequent
    // events (tool calls, info lines, phase changes) sit below it.
    this.live = null;

    const entry = this.streamToLog(phase, ev);
    if (entry) {
      this.emit("log", entry);
      this.tail.push({ ts: entry.ts, phase: entry.phase, kind: entry.kind, text: entry.text });
      if (this.tail.length > this.TAIL_MAX) this.tail.splice(0, this.tail.length - this.TAIL_MAX);
    }
    if (ev.type === "phase_start") this.emit("phase", phase, "running", ev.message);
    if (ev.type === "phase_ok") this.emit("phase", phase, "ok", ev.message);
    if (ev.type === "phase_fail") this.emit("phase", phase, "fail", ev.message);
  }

  private emitLive(): void {
    const p = this.live;
    if (!p) return;
    // Normalize whitespace for display: collapse runs of spaces/tabs,
    // compress 3+ newlines to paragraph breaks, and strip horizontal
    // whitespace around newlines. Do NOT trim the ends — the TUI wraps
    // & tails, and trimming would jitter the rendered viewport every
    // tick. `text.trim()` is only used to detect an "empty so far" case.
    const display = p.text
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]*\n[ \t]*/g, "\n");
    if (!display.trim()) return;
    this.emit("log", {
      id: p.id,
      ts: p.ts,
      phase: p.phase,
      kind: p.kind,
      text: display,
    } satisfies LogEntry);
  }

  private streamToLog(phase: PhaseId | undefined, ev: StreamEvent): LogEntry | undefined {
    const base = { id: ++this.logId, ts: Date.now(), phase };
    switch (ev.type) {
      // `message` and `reasoning` are coalesced in pushStreamEvent and never
      // reach this switch. We list them here only to keep the discriminated
      // union exhaustive for TypeScript.
      case "message":
      case "reasoning":
        return undefined;
      case "tool_use":
        return { ...base, kind: "tool", text: describeTool(ev.name, ev.input) };
      case "tool_result":
        return {
          ...base,
          kind: "tool_result",
          text: describeToolResult(ev.name, ev.output, ev.isError),
        };
      case "error":
        return { ...base, kind: "error", text: ev.message };
      case "stderr":
        return { ...base, kind: "stderr", text: ev.line };
      case "phase_start":
      case "phase_ok":
      case "phase_fail":
      case "info":
        return { ...base, kind: "info", text: ev.message ?? ev.type };
      case "warn":
        return { ...base, kind: "warn", text: ev.message ?? "warning" };
      default:
        return undefined;
    }
  }

  askPrompt(req: PromptRequest): Promise<string> {
    if (this.autoAnswer) {
      const fallback = req.default ?? req.options?.[0]?.value ?? "";
      return Promise.resolve(fallback);
    }
    return new Promise((resolve) => {
      const listener = (res: PromptResponse) => {
        if (res.id === req.id) {
          this.off("prompt:response", listener);
          resolve(res.value);
        }
      };
      this.on("prompt:response", listener);
      this.emit("prompt:request", req);
    });
  }

  answerPrompt(res: PromptResponse): void {
    this.emit("prompt:response", res);
  }
}

function safeStringify(v: unknown, max = 240): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + "…" : v;
  try {
    const s = JSON.stringify(v);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return String(v);
  }
}

/**
 * Turn a Copilot tool_use event into a one-line human-readable summary so
 * the Activity pane shows "edit src/foo.ts" instead of dumping raw JSON.
 */
function describeTool(name: string, rawInput: unknown): string {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const lower = name.toLowerCase();
  const str = (k: string): string | undefined => {
    const v = input[k];
    return typeof v === "string" ? v : undefined;
  };
  // File read / view
  if (/read|view/.test(lower)) {
    const p = str("path") ?? str("file") ?? str("filepath") ?? str("target_file");
    return p ? `read ${shortPath(p)}` : name;
  }
  // File write / create
  if (/write|create/.test(lower)) {
    const p = str("path") ?? str("file") ?? str("target_file");
    return p ? `write ${shortPath(p)}` : name;
  }
  // File edit / str-replace
  if (/edit|strreplace|str_replace|patch/.test(lower)) {
    const p = str("path") ?? str("target_file") ?? str("file");
    return p ? `edit ${shortPath(p)}` : name;
  }
  // Delete
  if (/delete|remove/.test(lower)) {
    const p = str("path") ?? str("target_file") ?? str("file");
    return p ? `delete ${shortPath(p)}` : name;
  }
  // Shell / bash / run
  if (/shell|bash|run|exec|terminal/.test(lower)) {
    const cmd = str("command") ?? str("cmd") ?? str("script") ?? str("input");
    return cmd ? `$ ${singleLine(cmd, 180)}` : name;
  }
  // Grep / search
  if (/grep|search/.test(lower)) {
    const pat = str("pattern") ?? str("query") ?? str("q");
    const path = str("path") ?? str("target_directory");
    return pat ? `grep ${truncate(pat, 60)}${path ? " in " + shortPath(path) : ""}` : name;
  }
  // Glob / find
  if (/glob|find|list/.test(lower)) {
    const p = str("glob_pattern") ?? str("pattern") ?? str("path") ?? str("target_directory");
    return p ? `${name.toLowerCase()} ${shortPath(p)}` : name;
  }
  // Fetch / web
  if (/fetch|web|http|curl/.test(lower)) {
    const url = str("url") ?? str("href");
    return url ? `fetch ${truncate(url, 120)}` : name;
  }
  // Think / plan
  if (/think|plan|todo/.test(lower)) {
    return name;
  }
  // Fallback: name + compact args
  const compact = safeStringify(rawInput, 120);
  return compact ? `${name} ${compact}` : name;
}

function describeToolResult(name: string | undefined, output: unknown, isError?: boolean): string {
  const prefix = (name ?? "tool") + " →";
  if (isError) return `${prefix} error: ${safeStringify(output, 200)}`;
  if (output == null) return `${prefix} ok`;
  if (typeof output === "string") {
    const oneLine = singleLine(output, 180);
    return `${prefix} ${oneLine}`;
  }
  if (Array.isArray(output)) return `${prefix} [${output.length} items]`;
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    const pieces = Object.entries(obj)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${safeStringify(v, 40)}`);
    return `${prefix} ${pieces.join(" ")}`;
  }
  return `${prefix} ${safeStringify(output, 180)}`;
}

function shortPath(p: string): string {
  if (!p) return p;
  // Strip a leading absolute workspace-style prefix so paths fit on one line.
  const m = p.match(/^\/Users\/[^/]+\/[^/]+\/(.+)$/);
  if (m) return m[1];
  if (p.length > 80) {
    const tail = p.slice(-77);
    return "…" + tail;
  }
  return p;
}

function singleLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Poetic phase titles. WordPress's tagline is "Code is Poetry" — so the tool
 * narrates each phase as a step in writing and binding a book of verse.
 * The backing `phase` id stays machine-friendly (`detect`, `plan`, …) for
 * commits, state files, and CLI args; these titles are for humans reading
 * the TUI.
 */
export const PHASE_TITLES: Record<PhaseId, string> = {
  detect: "Listening for the muse",
  plan: "Sketching the stanzas",
  boot: "Lighting the press",
  theme: "Weaving the theme",
  plugin: "Scoring the verses",
  normalize: "Measuring the meter",
  import: "Binding the manuscript",
  verify: "Reading it aloud",
  fix: "Revising the lines",
};

/** One-word verbs for compact spots (e.g. git commit messages if ever surfaced). */
export const PHASE_VERBS: Record<PhaseId, string> = {
  detect: "listen",
  plan: "sketch",
  boot: "light",
  theme: "weave",
  plugin: "score",
  normalize: "measure",
  import: "bind",
  verify: "read",
  fix: "revise",
};
