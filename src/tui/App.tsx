import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useStdin, useStdout } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type { PhaseId, PhaseStatus, LoopStatusEvent } from "../types.js";
import {
  PHASE_TITLES,
  UiBus,
  type EtaUpdate,
  type LogEntry,
  type MigrationSummary,
  type TuneTasks,
} from "./bus.js";
import { formatDuration } from "../phases/eta.js";

const WP_BLUE = "#21759B";
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

interface LoopState {
  phase: PhaseId;
  attempt: number;
  maxAttempts: number;
  fixPass: number;
  maxFixPasses: number;
  stage: string;
}

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
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  const [phases, setPhases] = useState<Record<PhaseId, PhaseRowState>>(() => {
    const init: Partial<Record<PhaseId, PhaseRowState>> = {};
    for (const id of phaseOrder) init[id] = { id, status: "pending" };
    return init as Record<PhaseId, PhaseRowState>;
  });
  const logsRef = useRef<LogEntry[]>([]);
  const [logsRev, setLogsRev] = useState(0);
  const [showRaw, setShowRaw] = useState(false);
  const [doneExit, setDoneExit] = useState<number | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [startedAt] = useState<number>(Date.now());
  const [eta, setEta] = useState<EtaUpdate | null>(null);
  const [summary, setSummary] = useState<MigrationSummary | null>(null);
  const [loopState, setLoopState] = useState<LoopState | null>(null);
  const [tuneInput, setTuneInput] = useState("");
  const [tuneTasks, setTuneTasks] = useState<TuneTasks | null>(null);

  useInput(
    (input, key) => {
      if (doneExit === 0 && tuneTasks) {
        if (input.toLowerCase() === "y" || key.return) {
          bus.emit("tune:build", tuneTasks);
          setTuneTasks(null);
          return;
        }
        if (input.toLowerCase() === "n" || key.escape) {
          setTuneTasks(null);
          return;
        }
      }
      if ((doneExit === null && input === "q") || (key.ctrl && input === "c")) {
        onExit?.();
        return;
      }
      if (input === "r") setShowRaw((v) => !v);
    },
    { isActive: isRawModeSupported },
  );

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    let flushTimer: NodeJS.Timeout | null = null;
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        setLogsRev((r) => r + 1);
      }, 80);
    };
    const onLog = (entry: LogEntry) => {
      const buf = logsRef.current;
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
    const onDone = (exitCode: number) => setDoneExit(exitCode);
    const onEta = (update: EtaUpdate) => setEta(update);
    const onSummary = (s: MigrationSummary) => setSummary(s);
    const onTuneTasks = (tasks: TuneTasks) => setTuneTasks(tasks);
    const onLoopStatus = (ls: LoopStatusEvent) => {
      setLoopState({
        phase: ls.phase,
        attempt: ls.attempt,
        maxAttempts: ls.maxAttempts,
        fixPass: ls.fixPass,
        maxFixPasses: ls.maxFixPasses,
        stage: ls.stage,
      });
    };
    bus.on("log", onLog);
    bus.on("phase", onPhase);
    bus.on("done", onDone);
    bus.on("eta", onEta);
    bus.on("summary", onSummary);
    bus.on("tune:tasks", onTuneTasks);
    bus.on("loop_status", onLoopStatus);
    return () => {
      bus.off("log", onLog);
      bus.off("phase", onPhase);
      bus.off("done", onDone);
      bus.off("eta", onEta);
      bus.off("summary", onSummary);
      bus.off("tune:tasks", onTuneTasks);
      bus.off("loop_status", onLoopStatus);
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [bus]);

  // ─── Layout math ────────────────────────────────────────────────────
  const HEADER_ROWS = 5;
  const FOOTER_ROWS = 3;
  const SUMMARY_ROWS = summary ? 9 : 0;
  const TUNE_ROWS = summary && doneExit === 0 ? 10 : 0;
  const bodyRows = Math.max(
    6,
    size.rows - HEADER_ROWS - FOOTER_ROWS - SUMMARY_ROWS - TUNE_ROWS,
  );

  const PANE_CHROME_ROWS = 2;
  const PANE_CHROME_COLS = 4;

  const leftWidth = Math.min(34, Math.max(22, Math.floor(size.cols * 0.22)));
  const rightWidth = size.cols - leftWidth - 2;
  const rightInner = Math.max(20, rightWidth - PANE_CHROME_COLS);

  // Press and Muse stack vertically — Press gets 65%, Muse 35%
  const pressHeight = Math.max(4, Math.floor(bodyRows * 0.65));
  const museHeight = Math.max(3, bodyRows - pressHeight);
  const pressViewRows = Math.max(2, pressHeight - PANE_CHROME_ROWS - 2);
  const museViewRows = Math.max(2, museHeight - PANE_CHROME_ROWS - 1);

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
    () => wrapLogs(pressLogs, rightInner, pressViewRows),
    [pressLogs, rightInner, pressViewRows],
  );

  const museText = useMemo(() => {
    const tail = logsRef.current.filter((l) => l.kind === "reasoning").slice(-400);
    const joined = tail.map((l) => l.text).join("");
    return joined
      .split(/\n{2,}/)
      .map((p) => p.replace(/[ \t]+/g, " ").trim())
      .filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logsRev]);

  const museView = useMemo(
    () => wrapMuse(museText, rightInner, museViewRows),
    [museText, rightInner, museViewRows],
  );

  const runningPhase = Object.values(phases).find((p) => p.status === "running") as
    | PhaseRowState
    | undefined;

  // Build phase sub-status string from loop state
  const phaseSubStatus = useMemo(() => {
    if (!loopState || !runningPhase) return undefined;
    if (loopState.phase !== runningPhase.id) return undefined;
    const parts: string[] = [];
    parts.push(`attempt ${loopState.attempt}/${loopState.maxAttempts}`);
    if (loopState.fixPass > 0) {
      parts.push(`fix ${loopState.fixPass}/${loopState.maxFixPasses}`);
    }
    parts.push(loopState.stage);
    return parts.join(" · ");
  }, [loopState, runningPhase]);

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
          loopState={loopState}
          now={now}
        />
        <Box width={1} />
        <Box flexDirection="column" width={rightWidth} height={bodyRows}>
          <PressPane
            width={rightWidth}
            height={pressHeight}
            view={pressView}
            showRaw={showRaw}
            phaseSubStatus={phaseSubStatus}
          />
          <MusePane
            width={rightWidth}
            height={museHeight}
            view={museView}
          />
        </Box>
      </Box>

      {summary ? <SummaryCard summary={summary} width={size.cols} /> : null}

      {summary && doneExit === 0 ? (
        <TuneRoom
          bus={bus}
          width={size.cols}
          value={tuneInput}
          onChange={setTuneInput}
          tasks={tuneTasks}
          onSubmitted={() => setTuneInput("")}
        />
      ) : null}

      <Footer
        doneExit={doneExit}
        width={size.cols}
      />
    </Box>
  );
}

// ─── Summary card ──────────────────────────────────────────────────────

function SummaryCard({ summary, width }: { summary: MigrationSummary; width: number }) {
  const row = (label: string, value: string, valueColor: string = WP_BLUE) => (
    <Box>
      <Box width={11} flexShrink={0}>
        <Text color={CHROME}>  {label}</Text>
      </Box>
      <Text color={valueColor} bold wrap="truncate-end">
        {value}
      </Text>
    </Box>
  );
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="green"
      paddingX={1}
      width={width}
      flexShrink={0}
    >
      <Box>
        <Text color="green" bold>
          ✦ Migration complete — copy these before closing:
        </Text>
      </Box>
      {row("Site:", summary.siteUrl)}
      {row("Admin:", summary.adminUrl)}
      {row("Username:", summary.adminUser, "yellow")}
      {row("Password:", summary.adminPassword, "yellow")}
      {row("Source:", summary.sourceDir, CHROME)}
      <Box>
        <Text color={CHROME}>
          {"  Took " +
            formatDuration(summary.durationSeconds) +
            " · `npx wp-env stop` pauses the stack, `npx wp-env start` resumes."}
        </Text>
      </Box>
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
  loopState,
  now,
}: {
  width: number;
  height: number;
  phaseOrder: PhaseId[];
  phases: Record<PhaseId, PhaseRowState>;
  activePhase?: PhaseId;
  loopState: LoopState | null;
  now: number;
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
        const loopInfo =
          isActive && loopState && loopState.phase === id
            ? ` [${loopState.attempt}/${loopState.maxAttempts}]`
            : "";
        return (
          <Box key={id}>
            <Text color={statusColor(p.status)}>{statusGlyph(p.status, now)}</Text>
            <Text> </Text>
            <Text
              color={isActive ? WP_BLUE : statusColor(p.status)}
              bold={isActive}
              wrap="truncate-end"
            >
              {PHASE_TITLES[id]}
            </Text>
            {loopInfo ? (
              <Text color="cyan" dimColor>
                {loopInfo}
              </Text>
            ) : null}
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
  phaseSubStatus,
}: {
  width: number;
  height: number;
  view: { lines: PressLineRow[]; hiddenAbove: number };
  showRaw: boolean;
  phaseSubStatus?: string;
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
          {showRaw ? "  · raw pages on (press r)" : ""}
        </Text>
      </Box>
      {phaseSubStatus ? (
        <Text color="cyan" dimColor>
          {"› "}{phaseSubStatus}
        </Text>
      ) : null}
      {view.hiddenAbove > 0 ? (
        <Text color={CHROME}>
          ▲ {view.hiddenAbove} older line{view.hiddenAbove === 1 ? "" : "s"} above
        </Text>
      ) : !phaseSubStatus ? (
        <Text color={CHROME}>
          {"─".repeat(Math.max(4, width - 4))}
        </Text>
      ) : null}
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
    </Box>
  );
}

// ─── Muse (reasoning) ──────────────────────────────────────────────────

function MusePane({
  width,
  height,
  view,
}: {
  width: number;
  height: number;
  view: { lines: string[]; hiddenAbove: number };
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
    </Box>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────

function TuneRoom({
  bus,
  width,
  value,
  onChange,
  tasks,
  onSubmitted,
}: {
  bus: UiBus;
  width: number;
  value: string;
  onChange: (v: string) => void;
  tasks: TuneTasks | null;
  onSubmitted: () => void;
}) {
  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    bus.emit("tune:request", { text: trimmed });
    onSubmitted();
  };
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      width={width}
      flexShrink={0}
    >
      <Text color="yellow" bold>
        Tune the Press
      </Text>
      <Text color={CHROME} wrap="wrap">
        Whisper the small things still off — theme drift, missing links, odd spacing, shortcode quirks — and I will score them into a repair list.
      </Text>
      {tasks ? (
        <>
          <Text color="green" bold>
            Plan is ready, go? <Text color="white">Y/n</Text>
          </Text>
          <Text color={CHROME}>
            Press Y (or Enter) to let the agent work through the repair list. Press n/Esc to keep the plan only.
          </Text>
        </>
      ) : (
        <>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput value={value} onChange={onChange} onSubmit={submit} placeholder="e.g. mobile menu overlaps the hero; /blog page spacing is wrong" />
          </Box>
          <Text color={CHROME}>
            The agent's draft and file path will appear in Press.
          </Text>
        </>
      )}
    </Box>
  );
}

function Footer({
  doneExit,
  width,
}: {
  doneExit: number | null;
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
        <Text color={CHROME} wrap="truncate-end">
          <Spinner type="dots" /> composing — <Text bold>r</Text> raw pages,{" "}
          <Text bold>q</Text> quit
        </Text>
      ) : doneExit === 0 ? (
        <Text color="green" bold wrap="truncate-end">
          ✦ the volume is bound — tune above, Ctrl-C to close
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

function wrapLogs(
  logs: LogEntry[],
  width: number,
  maxRows: number,
): { lines: PressLineRow[]; hiddenAbove: number } {
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
  const hiddenAbove = Math.max(0, flat.length - maxRows) + Math.max(0, logs.length - reverseBuckets.length);
  const kept = flat.slice(-maxRows);
  kept.forEach((row, i) => {
    row.id = `${row.id}-${i}`;
  });
  return { lines: kept, hiddenAbove };
}

function wrapMuse(
  paragraphs: string[],
  width: number,
  maxRows: number,
): { lines: string[]; hiddenAbove: number } {
  if (paragraphs.length === 0) return { lines: [], hiddenAbove: 0 };
  const allLines: string[] = [];
  paragraphs.forEach((p, i) => {
    if (i > 0) allLines.push("");
    for (const line of wrapText(p, width)) allLines.push(line);
  });
  const hiddenAbove = Math.max(0, allLines.length - maxRows);
  return { lines: allLines.slice(-maxRows), hiddenAbove };
}

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

function statusGlyph(s: PhaseStatus, now = Date.now()): string {
  switch (s) {
    case "pending":
      return "○";
    case "running":
      return ["◐", "◓", "◑", "◒"][Math.floor(now / 500) % 4];
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
