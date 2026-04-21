import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useStdin, useStdout } from "ink";
import Spinner from "ink-spinner";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import type { PhaseId, PhaseStatus } from "../types.js";
import {
  PHASE_TITLES,
  UiBus,
  type EtaUpdate,
  type LogEntry,
  type PromptRequest,
} from "./bus.js";
import { formatDuration } from "../phases/eta.js";

/** WordPress brand blue — used for the headline and accents. */
const WP_BLUE = "#21759B";
/** Soft grey for chrome (borders, hints) so content dominates the eye. */
const CHROME = "#6B7785";

const MIN_COLS = 80;
const MIN_ROWS = 20;

interface AppProps {
  bus: UiBus;
  sourceDir: string;
  phaseOrder: PhaseId[];
  onExit?: () => void;
}

interface PhaseRowState {
  id: PhaseId;
  status: PhaseStatus;
  message?: string;
}

/**
 * Top-level dashboard. Built as a fixed-size grid measured against the
 * terminal's current width/height so panes never overflow. Each content pane
 * (Press, Muse) computes a hard line budget for its viewport and renders the
 * tail of the buffer that fits, with a small "N more above" indicator when
 * older rows were clipped. Multi-line log chunks word-wrap inside their
 * column instead of being truncated to one line.
 */
export function App({ bus, sourceDir, phaseOrder, onExit }: AppProps) {
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();

  const [size, setSize] = useState<{ cols: number; rows: number }>(() => ({
    cols: Math.max(stdout?.columns ?? 120, MIN_COLS),
    rows: Math.max(stdout?.rows ?? 40, MIN_ROWS),
  }));

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setSize({
        cols: Math.max(stdout.columns ?? 120, MIN_COLS),
        rows: Math.max(stdout.rows ?? 40, MIN_ROWS),
      });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const [phases, setPhases] = useState<Record<PhaseId, PhaseRowState>>(() => {
    const init: Partial<Record<PhaseId, PhaseRowState>> = {};
    for (const id of phaseOrder) init[id] = { id, status: "pending" };
    return init as Record<PhaseId, PhaseRowState>;
  });
  const logsRef = useRef<LogEntry[]>([]);
  const [logsRev, setLogsRev] = useState(0);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [textValue, setTextValue] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [doneExit, setDoneExit] = useState<number | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [startedAt] = useState<number>(Date.now());
  const [eta, setEta] = useState<EtaUpdate | null>(null);

  useInput(
    (input, key) => {
      if (input === "q" || (key.ctrl && input === "c")) {
        onExit?.();
        return;
      }
      if (prompt) return;
      if (input === "r") setShowRaw((v) => !v);
    },
    { isActive: isRawModeSupported },
  );

  useEffect(() => {
    if (doneExit !== null) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [doneExit]);

  const promptActiveRef = useRef<boolean>(false);
  useEffect(() => {
    promptActiveRef.current = prompt !== null;
    setLogsRev((r) => r + 1);
  }, [prompt]);

  useEffect(() => {
    let flushTimer: NodeJS.Timeout | null = null;
    const scheduleFlush = () => {
      if (promptActiveRef.current) return;
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        setLogsRev((r) => r + 1);
      }, 80);
    };
    const onLog = (entry: LogEntry) => {
      const buf = logsRef.current;
      // Live-streaming entries (assistant / reasoning deltas) reuse the
      // same id across every delta so the UI replaces them in place
      // instead of stacking a new row per token. Scan the recent tail —
      // a finite window is enough because the bus always replays an
      // in-flight stream consecutively.
      const windowStart = Math.max(0, buf.length - 8);
      for (let i = buf.length - 1; i >= windowStart; i--) {
        if (buf[i].id === entry.id) {
          buf[i] = entry;
          scheduleFlush();
          return;
        }
      }
      buf.push(entry);
      if (buf.length > 2000) buf.splice(0, buf.length - 2000);
      scheduleFlush();
    };
    const onPhase = (id: PhaseId, status: PhaseStatus, message?: string) => {
      setPhases((prev) => ({ ...prev, [id]: { id, status, message } }));
    };
    const onPrompt = (req: PromptRequest) => {
      setPrompt(req);
      setTextValue(req.default ?? "");
    };
    const onDone = (exitCode: number) => setDoneExit(exitCode);
    const onEta = (update: EtaUpdate) => setEta(update);
    bus.on("log", onLog);
    bus.on("phase", onPhase);
    bus.on("prompt:request", onPrompt);
    bus.on("done", onDone);
    bus.on("eta", onEta);
    return () => {
      bus.off("log", onLog);
      bus.off("phase", onPhase);
      bus.off("prompt:request", onPrompt);
      bus.off("done", onDone);
      bus.off("eta", onEta);
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [bus]);

  // ─── Layout math ─────────────────────────────────────────────────────
  // The header takes a fixed number of rows, the footer takes one, and the
  // prompt (when open) takes up to ~8 rows. Everything else goes to the
  // three main panes. We pick column widths so Cantos stays readable and
  // Press + Muse split the remainder evenly.
  const HEADER_ROWS = 5;
  const FOOTER_ROWS = 3;
  const PROMPT_ROWS = prompt ? promptRowCount(prompt) : 0;
  const bodyRows = Math.max(6, size.rows - HEADER_ROWS - FOOTER_ROWS - PROMPT_ROWS);

  // Each pane renders its content inside a single-line border + 1 char
  // horizontal padding. That eats 2 rows (top/bottom border) and 2 cols
  // (left/right border + padding on each side).
  const PANE_CHROME_ROWS = 2;
  const PANE_CHROME_COLS = 4; // 1 border + 1 pad, ×2
  const viewportRows = Math.max(3, bodyRows - PANE_CHROME_ROWS - 2); // -2: title + hint

  const leftWidth = Math.min(34, Math.max(22, Math.floor(size.cols * 0.22)));
  const remaining = size.cols - leftWidth - 2; // gap between Cantos and Press
  const centerWidth = Math.max(28, Math.floor(remaining / 2));
  const rightWidth = Math.max(28, remaining - centerWidth - 1);
  const centerInner = Math.max(20, centerWidth - PANE_CHROME_COLS);
  const rightInner = Math.max(20, rightWidth - PANE_CHROME_COLS);

  // ─── Content selection ──────────────────────────────────────────────
  const pressLogs = useMemo(() => {
    return logsRef.current.filter((l) => {
      if (l.kind === "reasoning") return false;
      if (!showRaw && l.kind === "raw") return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRaw, logsRev]);

  const pressView = useMemo(
    () => wrapLogs(pressLogs, centerInner, viewportRows),
    [pressLogs, centerInner, viewportRows],
  );

  const museText = useMemo(() => {
    const tail = logsRef.current.filter((l) => l.kind === "reasoning").slice(-400);
    const joined = tail.map((l) => l.text).join(" ");
    return joined
      .split(/\n{2,}/)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logsRev]);

  const museView = useMemo(
    () => wrapMuse(museText, rightInner, viewportRows),
    [museText, rightInner, viewportRows],
  );

  const lastActivityAt =
    logsRef.current.length > 0 ? logsRef.current[logsRef.current.length - 1].ts : undefined;
  const runningPhase = Object.values(phases).find((p) => p.status === "running") as
    | PhaseRowState
    | undefined;
  const idleSeconds = lastActivityAt
    ? Math.max(0, Math.floor((now - lastActivityAt) / 1000))
    : 0;
  const showMuseIndicator =
    doneExit === null && !!runningPhase && idleSeconds >= 3 && prompt === null;

  return (
    <Box flexDirection="column" width={size.cols} height={size.rows}>
      <Header
        sourceDir={sourceDir}
        startedAt={startedAt}
        now={now}
        eta={eta}
        width={size.cols}
      />

      <Box flexDirection="row" height={bodyRows}>
        <CantosPane
          width={leftWidth}
          height={bodyRows}
          phaseOrder={phaseOrder}
          phases={phases}
          activePhase={runningPhase?.id}
        />
        <Box width={1} />
        <PressPane
          width={centerWidth}
          height={bodyRows}
          view={pressView}
          showRaw={showRaw}
          museIndicator={
            showMuseIndicator ? { phase: runningPhase!.id, idleSeconds } : undefined
          }
          paused={!!prompt}
        />
        <Box width={1} />
        <MusePane
          width={rightWidth}
          height={bodyRows}
          view={museView}
          empty={museText.length === 0}
        />
      </Box>

      {prompt ? (
        <PromptView
          bus={bus}
          prompt={prompt}
          textValue={textValue}
          setTextValue={setTextValue}
          width={size.cols}
          onAnswered={() => {
            setPrompt(null);
            setTextValue("");
          }}
        />
      ) : null}

      <Footer
        doneExit={doneExit}
        promptActive={!!prompt}
        width={size.cols}
      />
    </Box>
  );
}

// ─── Header ────────────────────────────────────────────────────────────

function Header({
  sourceDir,
  startedAt,
  now,
  eta,
  width,
}: {
  sourceDir: string;
  startedAt: number;
  now: number;
  eta: EtaUpdate | null;
  width: number;
}) {
  const dir = truncateMiddle(sourceDir, width - 18);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={WP_BLUE}
      paddingX={2}
      width={width}
      flexShrink={0}
    >
      <Box>
        <Text color={WP_BLUE} bold>
          to WordPress
        </Text>
        <Text color={CHROME}>  ·  </Text>
        <Text italic color={WP_BLUE}>
          Code is Poetry.
        </Text>
        <Text color={CHROME}>  ·  </Text>
        <Text color={CHROME}>manuscript </Text>
        <Text>{dir}</Text>
      </Box>
      <Box>
        <Text color={CHROME}>elapsed </Text>
        <Text>{formatDuration((now - startedAt) / 1000)}</Text>
        <Text color={CHROME}>   full verse </Text>
        <Text color={eta ? WP_BLUE : CHROME}>
          {eta ? formatDuration(eta.totalSeconds) : "measuring…"}
        </Text>
        <Text color={CHROME}>   remaining </Text>
        <Text color={eta ? "green" : CHROME} bold>
          {eta ? formatDuration(eta.remainingSeconds) : "—"}
        </Text>
        {eta?.active ? (
          <>
            <Text color={CHROME}>   writing </Text>
            <Text color="magenta">{PHASE_TITLES[eta.active]}</Text>
          </>
        ) : null}
      </Box>
    </Box>
  );
}

// ─── Cantos (phases) ───────────────────────────────────────────────────

function CantosPane({
  width,
  height,
  phaseOrder,
  phases,
  activePhase,
}: {
  width: number;
  height: number;
  phaseOrder: PhaseId[];
  phases: Record<PhaseId, PhaseRowState>;
  activePhase?: PhaseId;
}) {
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={CHROME}
      paddingX={1}
      flexShrink={0}
    >
      <Text bold color={WP_BLUE}>
        Cantos
      </Text>
      <Text color={CHROME}>
        {"─".repeat(Math.max(4, width - 4))}
      </Text>
      {phaseOrder.map((id) => {
        const p = phases[id];
        const isActive = id === activePhase;
        return (
          <Box key={id}>
            <Text color={statusColor(p.status)}>{statusGlyph(p.status)}</Text>
            <Text> </Text>
            <Text
              color={isActive ? WP_BLUE : statusColor(p.status)}
              bold={isActive}
              wrap="truncate-end"
            >
              {PHASE_TITLES[id]}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ─── Press (activity) ──────────────────────────────────────────────────

interface PressLineRow {
  id: string;
  kind: LogEntry["kind"];
  prefix: string;
  text: string;
  continuation: boolean;
  phase?: PhaseId;
}

function PressPane({
  width,
  height,
  view,
  showRaw,
  museIndicator,
  paused,
}: {
  width: number;
  height: number;
  view: { lines: PressLineRow[]; hiddenAbove: number };
  showRaw: boolean;
  museIndicator?: { phase: PhaseId; idleSeconds: number };
  paused: boolean;
}) {
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={CHROME}
      paddingX={1}
      flexShrink={1}
    >
      <Box>
        <Text bold color={WP_BLUE}>
          Press
        </Text>
        <Text color={CHROME}>
          {paused
            ? "  · paused (awaiting your answer)"
            : showRaw
              ? "  · raw pages on (press r)"
              : ""}
        </Text>
      </Box>
      {view.hiddenAbove > 0 ? (
        <Text color={CHROME}>
          ▲ {view.hiddenAbove} older line{view.hiddenAbove === 1 ? "" : "s"} above
        </Text>
      ) : (
        <Text color={CHROME}>
          {"─".repeat(Math.max(4, width - 4))}
        </Text>
      )}
      {view.lines.map((row) => (
        <Box key={row.id}>
          {row.continuation ? (
            <Text>{" ".repeat(row.prefix.length)}</Text>
          ) : (
            <Text color={kindColor(row.kind)}>{row.prefix}</Text>
          )}
          <Text color={row.continuation ? CHROME : "white"}>{row.text}</Text>
        </Box>
      ))}
      {view.lines.length === 0 ? (
        <Text color={CHROME}>(the press is warming)</Text>
      ) : null}
      {museIndicator ? (
        <Box marginTop={0}>
          <Text color="magenta">
            <Spinner type="dots" /> muse ponders · quiet {museIndicator.idleSeconds}s in{" "}
            {museIndicator.phase}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ─── Muse (reasoning) ──────────────────────────────────────────────────

function MusePane({
  width,
  height,
  view,
  empty,
}: {
  width: number;
  height: number;
  view: { lines: string[]; hiddenAbove: number };
  empty: boolean;
}) {
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      flexShrink={1}
    >
      <Text bold color="magenta">
        Muse
      </Text>
      {view.hiddenAbove > 0 ? (
        <Text color={CHROME}>
          ▲ {view.hiddenAbove} older line{view.hiddenAbove === 1 ? "" : "s"} above
        </Text>
      ) : (
        <Text color={CHROME}>
          {"─".repeat(Math.max(4, width - 4))}
        </Text>
      )}
      {view.lines.map((l, i) => (
        <Text key={i} color="magenta" dimColor>
          {l}
        </Text>
      ))}
      {empty ? (
        <Text color={CHROME} wrap="wrap">
          (the muse is silent — Copilot CLI only streams reasoning for OpenAI
          models. Try <Text color="cyan">COPILOT_MODEL=gpt-5.4</Text>{" "}
          <Text color="cyan">COPILOT_EFFORT=high</Text> to hear her.)
        </Text>
      ) : null}
    </Box>
  );
}

// ─── Prompt + Footer ───────────────────────────────────────────────────

function promptRowCount(prompt: PromptRequest): number {
  // rough upper bound: title + message + options (or input) + padding
  if (prompt.kind === "select" || prompt.kind === "confirm") {
    return 4 + Math.min(8, (prompt.options?.length ?? 2));
  }
  return 6;
}

function PromptView({
  bus,
  prompt,
  textValue,
  setTextValue,
  width,
  onAnswered,
}: {
  bus: UiBus;
  prompt: PromptRequest;
  textValue: string;
  setTextValue: (v: string) => void;
  width: number;
  onAnswered: () => void;
}) {
  const handleSelect = (item: { value: string }) => {
    bus.answerPrompt({ id: prompt.id, value: item.value });
    onAnswered();
  };
  const handleSubmit = (value: string) => {
    bus.answerPrompt({ id: prompt.id, value });
    onAnswered();
  };
  return (
    <Box
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      flexDirection="column"
      width={width}
      flexShrink={0}
    >
      <Text bold color="yellow">
        ? {prompt.title}
      </Text>
      <Text wrap="wrap">{prompt.message}</Text>
      {prompt.kind === "select" || prompt.kind === "confirm" ? (
        <SelectInput
          items={
            prompt.options ??
            [
              { label: "Yes", value: "yes" },
              { label: "No", value: "no" },
            ]
          }
          onSelect={handleSelect}
        />
      ) : (
        <Box>
          <Text color="cyan">{"› "}</Text>
          <TextInput value={textValue} onChange={setTextValue} onSubmit={handleSubmit} />
        </Box>
      )}
    </Box>
  );
}

function Footer({
  doneExit,
  promptActive,
  width,
}: {
  doneExit: number | null;
  promptActive: boolean;
  width: number;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={CHROME}
      paddingX={1}
      width={width}
      flexShrink={0}
    >
      {doneExit === null ? (
        promptActive ? (
          <Text color="yellow" wrap="truncate-end">
            ↑↓ to choose, ↵ to commit, <Text bold>q</Text> to set down the pen
          </Text>
        ) : (
          <Text color={CHROME} wrap="truncate-end">
            <Spinner type="dots" /> composing — <Text bold>r</Text> raw pages,{" "}
            <Text bold>q</Text> quit
          </Text>
        )
      ) : doneExit === 0 ? (
        <Text color="green" bold wrap="truncate-end">
          ✦ the volume is bound — q to close
        </Text>
      ) : (
        <Text color="red" bold wrap="truncate-end">
          ✖ the press fell silent · exit {doneExit} · q to close
        </Text>
      )}
    </Box>
  );
}

// ─── Utilities ─────────────────────────────────────────────────────────

/**
 * Turn the live log buffer into a set of concrete rendered rows that fit
 * the pane's viewport. Each LogEntry is expanded into one or more wrapped
 * lines (word-wrap to `width`), then the tail that fits in `maxRows` is
 * kept. A count of hidden-above rows is returned so the pane can render a
 * scroll indicator.
 */
function wrapLogs(
  logs: LogEntry[],
  width: number,
  maxRows: number,
): { lines: PressLineRow[]; hiddenAbove: number } {
  const rendered: PressLineRow[] = [];
  // We only need `maxRows` rows of tail — so walk backward, wrapping as
  // we go, until we've accumulated enough. This keeps the render cheap on
  // long sessions.
  let produced = 0;
  const reverseBuckets: PressLineRow[][] = [];
  for (let i = logs.length - 1; i >= 0 && produced < maxRows; i--) {
    const entry = logs[i];
    const prefix = `${kindGlyph(entry.kind)} ${entry.phase ? `[${entry.phase}] ` : ""}`;
    const available = Math.max(10, width - prefix.length);
    const wrapped = wrapText(entry.text, available);
    const rows: PressLineRow[] = wrapped.map((text, idx) => ({
      id: `${entry.id}-${idx}`,
      kind: entry.kind,
      prefix,
      text,
      continuation: idx > 0,
      phase: entry.phase,
    }));
    reverseBuckets.push(rows);
    produced += rows.length;
  }
  const flat: PressLineRow[] = reverseBuckets
    .reverse()
    .reduce<PressLineRow[]>((acc, b) => acc.concat(b), []);
  // `flat` may exceed maxRows because the earliest bucket was fetched
  // whole; trim from the head so we keep the most-recent activity.
  const hiddenAbove = Math.max(0, flat.length - maxRows) + Math.max(0, logs.length - reverseBuckets.length);
  const kept = flat.slice(-maxRows);
  kept.forEach((row, i) => {
    // Use stable keys; if an entry wraps to > width we might get dupes
    // after trimming — disambiguate by index.
    row.id = `${row.id}-${i}`;
  });
  return { lines: kept, hiddenAbove };
}

/**
 * Produce a single flowing view of the Muse pane: concatenate recent
 * reasoning paragraphs, word-wrap, and keep the tail that fits.
 */
function wrapMuse(
  paragraphs: string[],
  width: number,
  maxRows: number,
): { lines: string[]; hiddenAbove: number } {
  if (paragraphs.length === 0) return { lines: [], hiddenAbove: 0 };
  const allLines: string[] = [];
  paragraphs.forEach((p, i) => {
    if (i > 0) allLines.push(""); // paragraph break
    for (const line of wrapText(p, width)) allLines.push(line);
  });
  const hiddenAbove = Math.max(0, allLines.length - maxRows);
  return { lines: allLines.slice(-maxRows), hiddenAbove };
}

/** Classic greedy word-wrap to a hard column width. Handles long tokens
 * (URLs, hashes) by breaking them mid-string. */
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length === 0) {
      out.push("");
      continue;
    }
    const words = rawLine.split(/ +/);
    let cur = "";
    for (const word of words) {
      if (word.length > width) {
        if (cur) {
          out.push(cur);
          cur = "";
        }
        let rest = word;
        while (rest.length > width) {
          out.push(rest.slice(0, width));
          rest = rest.slice(width);
        }
        cur = rest;
        continue;
      }
      if (!cur) {
        cur = word;
      } else if (cur.length + 1 + word.length <= width) {
        cur += " " + word;
      } else {
        out.push(cur);
        cur = word;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function truncateMiddle(s: string, max: number): string {
  if (!s || s.length <= max || max < 10) return s;
  const keep = Math.floor((max - 1) / 2);
  return s.slice(0, keep) + "…" + s.slice(-keep);
}

function statusGlyph(s: PhaseStatus): string {
  switch (s) {
    case "pending":
      return "○";
    case "running":
      return "◐";
    case "ok":
      return "●";
    case "fail":
      return "✖";
    case "skipped":
      return "—";
  }
}

function statusColor(s: PhaseStatus): string {
  switch (s) {
    case "pending":
      return CHROME;
    case "running":
      return "cyan";
    case "ok":
      return "green";
    case "fail":
      return "red";
    case "skipped":
      return "yellow";
  }
}

function kindGlyph(k: LogEntry["kind"]): string {
  switch (k) {
    case "assistant":
      return "›";
    case "reasoning":
      return "…";
    case "tool":
      return "⏵";
    case "tool_result":
      return "⏴";
    case "error":
      return "✖";
    case "warn":
      return "!";
    case "stderr":
      return "·";
    case "raw":
      return "•";
    case "info":
      return "·";
    default:
      return "•";
  }
}

function kindColor(k: LogEntry["kind"]): string {
  switch (k) {
    case "assistant":
      return "green";
    case "reasoning":
      return "magenta";
    case "tool":
      return "cyan";
    case "tool_result":
      return "blue";
    case "error":
      return "red";
    case "warn":
      return "yellow";
    case "stderr":
      return "gray";
    default:
      return "white";
  }
}
