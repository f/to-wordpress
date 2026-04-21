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

export class UiBus extends EventEmitter {
  private logId = 0;
  autoAnswer = false;

  pushStreamEvent(phase: PhaseId | undefined, ev: StreamEvent): void {
    this.emit("stream", phase, ev);
    const entry = this.streamToLog(phase, ev);
    if (entry) this.emit("log", entry);
    if (ev.type === "phase_start") this.emit("phase", phase, "running", ev.message);
    if (ev.type === "phase_ok") this.emit("phase", phase, "ok", ev.message);
    if (ev.type === "phase_fail") this.emit("phase", phase, "fail", ev.message);
  }

  private streamToLog(phase: PhaseId | undefined, ev: StreamEvent): LogEntry | undefined {
    const base = { id: ++this.logId, ts: Date.now(), phase };
    switch (ev.type) {
      case "message": {
        const txt = ev.text?.trim();
        if (!txt) return undefined;
        return { ...base, kind: "assistant", text: txt };
      }
      case "reasoning": {
        const txt = ev.text?.trim();
        if (!txt) return undefined;
        return { ...base, kind: "reasoning", text: txt };
      }
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
