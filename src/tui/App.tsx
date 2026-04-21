import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import Spinner from "ink-spinner";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import type { PhaseId, PhaseStatus } from "../types.js";
import { PHASE_TITLES, UiBus, type LogEntry, type PromptRequest } from "./bus.js";

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

export function App({ bus, sourceDir, phaseOrder, onExit }: AppProps) {
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
  const { isRawModeSupported } = useStdin();

  useInput(
    (input, key) => {
      if (prompt) return;
      if (input === "q" || (key.ctrl && input === "c")) onExit?.();
      if (input === "r") setShowRaw((v) => !v);
    },
    { isActive: isRawModeSupported },
  );

  // Heartbeat tick so the "thinking…" indicator updates even when no new
  // events have arrived from Copilot recently.
  useEffect(() => {
    if (doneExit !== null) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [doneExit]);

  useEffect(() => {
    let flushTimer: NodeJS.Timeout | null = null;
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        setLogsRev((r) => r + 1);
      }, 60);
    };
    const onLog = (entry: LogEntry) => {
      const buf = logsRef.current;
      buf.push(entry);
      if (buf.length > 500) buf.splice(0, buf.length - 500);
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
    bus.on("log", onLog);
    bus.on("phase", onPhase);
    bus.on("prompt:request", onPrompt);
    bus.on("done", onDone);
    return () => {
      bus.off("log", onLog);
      bus.off("phase", onPhase);
      bus.off("prompt:request", onPrompt);
      bus.off("done", onDone);
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [bus]);

  const visibleLogs = useMemo(
    () => (showRaw ? logsRef.current : logsRef.current.filter((l) => l.kind !== "raw")).slice(-40),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showRaw, logsRev],
  );

  const lastActivityAt =
    logsRef.current.length > 0 ? logsRef.current[logsRef.current.length - 1].ts : undefined;
  const runningPhaseId = (Object.values(phases).find((p) => p.status === "running") as PhaseRowState | undefined)?.id;
  const idleSeconds = lastActivityAt ? Math.max(0, Math.floor((now - lastActivityAt) / 1000)) : 0;
  const showThinking = doneExit === null && runningPhaseId && idleSeconds >= 3;

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold color="cyan">to-wordpress</Text>
        <Text dimColor>source: {sourceDir}</Text>
      </Box>

      <Box>
        <Box flexDirection="column" width={32} borderStyle="single" paddingX={1} marginRight={1}>
          <Text bold>Phases</Text>
          {phaseOrder.map((id) => {
            const p = phases[id];
            return (
              <Box key={id}>
                <Text>{statusGlyph(p.status)} </Text>
                <Text color={statusColor(p.status)}>{PHASE_TITLES[id]}</Text>
              </Box>
            );
          })}
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
          <Box>
            <Text bold>Activity</Text>
            <Text dimColor>  (last {visibleLogs.length} events)</Text>
          </Box>
          {visibleLogs.map((l) => (
            <Box key={l.id}>
              <Text color={kindColor(l.kind)}>{kindGlyph(l.kind)} </Text>
              {l.phase ? <Text dimColor>[{l.phase}] </Text> : null}
              <Text wrap="truncate-end">{truncate(l.text, 240)}</Text>
            </Box>
          ))}
          {visibleLogs.length === 0 ? <Text dimColor>(waiting for activity)</Text> : null}
          {showThinking ? (
            <Box marginTop={1}>
              <Text color="magenta">
                <Spinner type="dots" /> copilot thinking… (idle {idleSeconds}s in {runningPhaseId})
              </Text>
            </Box>
          ) : null}
        </Box>
      </Box>

      {prompt ? (
        <PromptView
          bus={bus}
          prompt={prompt}
          textValue={textValue}
          setTextValue={setTextValue}
          onAnswered={() => {
            setPrompt(null);
            setTextValue("");
          }}
        />
      ) : null}

      <Box borderStyle="single" paddingX={1}>
        {doneExit === null ? (
          <Text dimColor>
            <Spinner type="dots" /> running — press <Text bold>r</Text> to toggle raw logs, <Text bold>q</Text> to quit
          </Text>
        ) : doneExit === 0 ? (
          <Text color="green" bold>All phases completed. Press q to exit.</Text>
        ) : (
          <Text color="red" bold>Migration exited with code {doneExit}. Press q to exit.</Text>
        )}
      </Box>
    </Box>
  );
}

function PromptView({
  bus,
  prompt,
  textValue,
  setTextValue,
  onAnswered,
}: {
  bus: UiBus;
  prompt: PromptRequest;
  textValue: string;
  setTextValue: (v: string) => void;
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
    <Box borderStyle="double" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text bold color="yellow">{prompt.title}</Text>
      <Text>{prompt.message}</Text>
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

function statusGlyph(s: PhaseStatus): string {
  switch (s) {
    case "pending":
      return "○";
    case "running":
      return "◐";
    case "ok":
      return "✔";
    case "fail":
      return "✖";
    case "skipped":
      return "—";
  }
}

function statusColor(s: PhaseStatus): string {
  switch (s) {
    case "pending":
      return "gray";
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
      return "🟢";
    case "reasoning":
      return "…";
    case "tool":
      return "›";
    case "tool_result":
      return "‹";
    case "error":
      return "✖";
    case "warn":
      return "!";
    case "stderr":
      return "·";
    case "raw":
      return "•";
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

function truncate(s: string, n: number): string {
  if (!s) return "";
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}
