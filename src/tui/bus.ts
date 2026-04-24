import { EventEmitter } from "node:events";
import type { PhaseId, PhaseStatus, StreamEvent, LoopStatusEvent } from "../types.js";

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
  /** Incremental delta for the current emit (headless writes this directly). */
  delta?: string;
}

export interface EtaUpdate {
  totalSeconds: number;
  remainingSeconds: number;
  active?: PhaseId;
}

export interface MigrationSummary {
  siteUrl: string;
  adminUrl: string;
  adminUser: string;
  adminPassword: string;
  sourceDir: string;
  durationSeconds: number;
}

type StreamKind = "assistant" | "reasoning";

/**
 * Maximum characters a single live entry can grow before we start a
 * fresh one. Keeps rendering cheap in the TUI.
 */
const LIVE_WRAP_CHARS = 4000;

export class UiBus extends EventEmitter {
  private logId = 0;
  /** The active streaming entry, or null between streams. */
  private live: { id: number; phase: PhaseId | undefined; kind: StreamKind; text: string; ts: number } | null = null;
  private tail: Array<{ ts: number; phase: PhaseId | undefined; kind: string; text: string }> = [];
  private readonly TAIL_MAX = 400;

  recentLogs(n = 120, phase?: PhaseId): string {
    const src = phase ? this.tail.filter((t) => t.phase === phase) : this.tail;
    return src
      .slice(-n)
      .map((t) => `[${t.kind}] ${t.text}`)
      .join("\n");
  }

  pushStreamEvent(phase: PhaseId | undefined, ev: StreamEvent): void {
    this.emit("stream", phase, ev);

    if (ev.type === "message" || ev.type === "reasoning") {
      const raw = ev.text ?? "";
      if (!raw) return;
      const kind: StreamKind = ev.type === "message" ? "assistant" : "reasoning";

      const sameStream =
        this.live !== null &&
        this.live.kind === kind &&
        this.live.phase === phase;

      if (!sameStream) {
        this.live = {
          id: ++this.logId,
          phase,
          kind,
          text: "",
          ts: Date.now(),
        };
      }

      this.live!.text += raw;

      if (this.live!.text.length > LIVE_WRAP_CHARS) {
        this.emitLive(raw);
        this.live = {
          id: ++this.logId,
          phase,
          kind,
          text: "",
          ts: Date.now(),
        };
      } else {
        this.emitLive(raw);
      }
      return;
    }

    // Non-streaming event — finalize the live stream
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
    if (ev.type === "loop_status") {
      this.emit("loop_status", ev as LoopStatusEvent);
    }
  }

  private emitLive(delta: string): void {
    const p = this.live;
    if (!p || !p.text.trim()) return;
    this.emit("log", {
      id: p.id,
      ts: p.ts,
      phase: p.phase,
      kind: p.kind,
      text: p.text,
      delta,
    } satisfies LogEntry);
  }

  private streamToLog(phase: PhaseId | undefined, ev: StreamEvent): LogEntry | undefined {
    const base = { id: ++this.logId, ts: Date.now(), phase };
    switch (ev.type) {
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
      case "stdout":
        return { ...base, kind: "raw", text: (ev as { line: string }).line ?? "" };
      case "loop_status":
        return undefined;
      default:
        return undefined;
    }
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

function describeTool(name: string, rawInput: unknown): string {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const lower = name.toLowerCase();
  const str = (k: string): string | undefined => {
    const v = input[k];
    return typeof v === "string" ? v : undefined;
  };
  if (/read|view/.test(lower)) {
    const p = str("path") ?? str("file") ?? str("filepath") ?? str("target_file");
    return p ? `read ${shortPath(p)}` : name;
  }
  if (/write|create/.test(lower)) {
    const p = str("path") ?? str("file") ?? str("target_file");
    return p ? `write ${shortPath(p)}` : name;
  }
  if (/edit|strreplace|str_replace|patch/.test(lower)) {
    const p = str("path") ?? str("target_file") ?? str("file");
    return p ? `edit ${shortPath(p)}` : name;
  }
  if (/delete|remove/.test(lower)) {
    const p = str("path") ?? str("target_file") ?? str("file");
    return p ? `delete ${shortPath(p)}` : name;
  }
  if (/shell|bash|run|exec|terminal/.test(lower)) {
    const cmd = str("command") ?? str("cmd") ?? str("script") ?? str("input");
    return cmd ? `$ ${singleLine(cmd, 180)}` : name;
  }
  if (/grep|search/.test(lower)) {
    const pat = str("pattern") ?? str("query") ?? str("q");
    const path = str("path") ?? str("target_directory");
    return pat ? `grep ${truncate(pat, 60)}${path ? " in " + shortPath(path) : ""}` : name;
  }
  if (/glob|find|list/.test(lower)) {
    const p = str("glob_pattern") ?? str("pattern") ?? str("path") ?? str("target_directory");
    return p ? `${name.toLowerCase()} ${shortPath(p)}` : name;
  }
  if (/fetch|web|http|curl/.test(lower)) {
    const url = str("url") ?? str("href");
    return url ? `fetch ${truncate(url, 120)}` : name;
  }
  if (/think|plan|todo/.test(lower)) {
    return name;
  }
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

export const PHASE_TITLES: Record<PhaseId, string> = {
  detect: "Listening for the muse",
  plan: "Sketching the stanzas",
  boot: "Lighting the press",
  theme: "Weaving the theme",
  normalize: "Measuring the meter",
  blockify: "Casting the blocks",
  plugin: "Scoring the verses",
  import: "Binding the manuscript",
  verify: "Reading it aloud",
  fix: "Revising the lines",
  testfix: "Road-testing every page",
};

export const PHASE_VERBS: Record<PhaseId, string> = {
  detect: "listen",
  plan: "sketch",
  boot: "light",
  theme: "weave",
  normalize: "measure",
  blockify: "cast",
  plugin: "score",
  import: "bind",
  verify: "read",
  fix: "revise",
  testfix: "test",
};
