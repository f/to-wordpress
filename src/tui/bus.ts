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
      case "message":
        return { ...base, kind: "assistant", text: ev.text };
      case "reasoning":
        return { ...base, kind: "reasoning", text: ev.text };
      case "tool_use":
        return {
          ...base,
          kind: "tool",
          text: `${ev.name}${ev.input ? " " + safeStringify(ev.input) : ""}`,
        };
      case "tool_result":
        return {
          ...base,
          kind: "tool_result",
          text: `${ev.name ?? "tool"} → ${safeStringify(ev.output)}`,
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

function safeStringify(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v.length > 240 ? v.slice(0, 240) + "…" : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 240 ? s.slice(0, 240) + "…" : s;
  } catch {
    return String(v);
  }
}

export const PHASE_TITLES: Record<PhaseId, string> = {
  detect: "Detect source",
  plan: "Plan migration",
  boot: "Boot wp-env",
  theme: "Generate theme",
  plugin: "Generate plugin",
  normalize: "Normalize content",
  import: "Import into WP",
  verify: "Verify migration",
  fix: "Auto-fix gaps",
};
