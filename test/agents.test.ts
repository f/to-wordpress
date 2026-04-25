/**
 * Smoke tests for both agent parsers + arg builders.
 *
 * Run via: node --import=tsx test/agents.test.ts
 * (tsx is installed as a dev dep; or use `npx tsx test/agents.test.ts`)
 *
 * Tests verify that:
 *   - Copilot CLI JSONL event shapes produce the expected CopilotEvent[]
 *   - Claude Code stream-json event shapes produce the expected CopilotEvent[]
 *   - Both arg builders include the binary-specific flags
 */
import assert from "node:assert/strict";
import { __testables } from "../src/agents/index.ts";

const {
  parseCopilotLine,
  parseClaudeLine,
  parseCodexLine,
  buildCopilotArgs,
  buildClaudeArgs,
  buildCodexArgs,
} = __testables;

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error((err as Error).message);
    failed++;
  }
}

// ─── Copilot parser ─────────────────────────────────────────────────────

console.log("\n[copilot parser]");

test("session init", () => {
  const evs = parseCopilotLine(JSON.stringify({
    type: "session.start",
    session_id: "sess_abc",
  }));
  assert.deepEqual(evs.find((e) => e.type === "session"), { type: "session", sessionId: "sess_abc" });
});

test("assistant message delta", () => {
  const evs = parseCopilotLine(JSON.stringify({
    type: "assistant.message_delta",
    data: { deltaContent: "Hello " },
  }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "message");
  if (evs[0].type === "message") {
    assert.equal(evs[0].text, "Hello ");
    assert.equal(evs[0].role, "assistant");
  }
});

test("assistant consolidation is dropped", () => {
  const evs = parseCopilotLine(JSON.stringify({
    type: "assistant.message",
    data: { content: "Final text" },
  }));
  assert.equal(evs.filter((e) => e.type === "message").length, 0);
});

test("reasoning delta", () => {
  const evs = parseCopilotLine(JSON.stringify({
    type: "assistant.reasoning_delta",
    data: { deltaContent: "thinking..." },
  }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "reasoning");
  if (evs[0].type === "reasoning") assert.equal(evs[0].text, "thinking...");
});

test("tool execution", () => {
  const evs = parseCopilotLine(JSON.stringify({
    type: "tool.execution_start",
    data: { toolName: "read_file", toolCallId: "t1", arguments: { path: "foo.txt" } },
  }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "tool_use");
  if (evs[0].type === "tool_use") {
    assert.equal(evs[0].name, "read_file");
    assert.equal(evs[0].id, "t1");
    assert.deepEqual(evs[0].input, { path: "foo.txt" });
  }
});

test("unparseable JSON falls back to stdout", () => {
  const evs = parseCopilotLine("not json at all");
  assert.deepEqual(evs, [{ type: "stdout", line: "not json at all" }]);
});

// ─── Claude parser ──────────────────────────────────────────────────────

console.log("\n[claude parser]");

test("system init", () => {
  const evs = parseClaudeLine(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "claude-sess-1",
    model: "claude-sonnet-4-5",
  }));
  assert.deepEqual(evs, [{ type: "session", sessionId: "claude-sess-1" }]);
});

test("text_delta streams as message", () => {
  const evs = parseClaudeLine(JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello " },
    },
  }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "message");
  if (evs[0].type === "message") {
    assert.equal(evs[0].text, "Hello ");
    assert.equal(evs[0].role, "assistant");
  }
});

test("thinking_delta streams as reasoning", () => {
  const evs = parseClaudeLine(JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Let me analyze..." },
    },
  }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "reasoning");
  if (evs[0].type === "reasoning") assert.equal(evs[0].text, "Let me analyze...");
});

test("assistant message extracts tool_use", () => {
  const evs = parseClaudeLine(JSON.stringify({
    type: "assistant",
    message: {
      id: "m1",
      role: "assistant",
      content: [
        { type: "text", text: "I'll read the file." },
        { type: "tool_use", id: "tc1", name: "Read", input: { path: "a.txt" } },
      ],
    },
  }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "tool_use");
  if (evs[0].type === "tool_use") {
    assert.equal(evs[0].name, "Read");
    assert.equal(evs[0].id, "tc1");
    assert.deepEqual(evs[0].input, { path: "a.txt" });
  }
});

test("user message extracts tool_result", () => {
  const evs = parseClaudeLine(JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tc1", content: "file contents" },
      ],
    },
  }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "tool_result");
  if (evs[0].type === "tool_result") {
    assert.equal(evs[0].id, "tc1");
    assert.equal(evs[0].output, "file contents");
    assert.equal(evs[0].isError, false);
  }
});

test("result error surfaces as error event", () => {
  const evs = parseClaudeLine(JSON.stringify({
    type: "result",
    subtype: "error_max_turns",
    error: "max turns exceeded",
  }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "error");
});

test("result success emits nothing (done comes from process exit)", () => {
  const evs = parseClaudeLine(JSON.stringify({
    type: "result",
    subtype: "success",
    duration_ms: 5000,
    total_cost_usd: 0.05,
  }));
  assert.equal(evs.length, 0);
});

test("unparseable JSON falls back to stdout", () => {
  const evs = parseClaudeLine("garbage");
  assert.deepEqual(evs, [{ type: "stdout", line: "garbage" }]);
});

// ─── Codex parser ───────────────────────────────────────────────────────

console.log("\n[codex parser]");

test("thread.started → session", () => {
  const evs = parseCodexLine(JSON.stringify({
    type: "thread.started",
    thread_id: "019dbf18-9f5f-74d0-ace8-4b1e7266a8b6",
  }));
  assert.deepEqual(evs, [{ type: "session", sessionId: "019dbf18-9f5f-74d0-ace8-4b1e7266a8b6" }]);
});

test("turn markers are ignored", () => {
  assert.deepEqual(parseCodexLine(JSON.stringify({ type: "turn.started" })), []);
  assert.deepEqual(parseCodexLine(JSON.stringify({ type: "turn.completed", usage: {} })), []);
});

test("agent_message → message", () => {
  const evs = parseCodexLine(JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: "Hello there" },
  }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "message");
  if (evs[0].type === "message") {
    assert.equal(evs[0].text, "Hello there");
    assert.equal(evs[0].role, "assistant");
  }
});

test("command_execution start → tool_use", () => {
  const evs = parseCodexLine(JSON.stringify({
    type: "item.started",
    item: {
      id: "item_1",
      type: "command_execution",
      command: "/bin/zsh -lc 'ls -l'",
      aggregated_output: "",
      exit_code: null,
      status: "in_progress",
    },
  }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "tool_use");
  if (evs[0].type === "tool_use") {
    assert.equal(evs[0].name, "shell");
    assert.equal(evs[0].id, "item_1");
    assert.deepEqual(evs[0].input, { command: "/bin/zsh -lc 'ls -l'" });
  }
});

test("command_execution completed non-zero → tool_result with isError=true", () => {
  const evs = parseCodexLine(JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "command_execution",
      command: "ls _missing.txt",
      aggregated_output: "ls: _missing.txt: No such file or directory\n",
      exit_code: 1,
      status: "failed",
    },
  }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "tool_result");
  if (evs[0].type === "tool_result") {
    assert.equal(evs[0].isError, true);
    assert.ok(String(evs[0].output).includes("No such file"));
  }
});

test("reasoning → reasoning event", () => {
  const evs = parseCodexLine(JSON.stringify({
    type: "item.completed",
    item: { id: "r1", type: "reasoning", text: "Analyzing..." },
  }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "reasoning");
  if (evs[0].type === "reasoning") assert.equal(evs[0].text, "Analyzing...");
});

test("unknown item type → generic tool activity", () => {
  const startEvs = parseCodexLine(JSON.stringify({
    type: "item.started",
    item: { id: "x1", type: "future_new_item", foo: "bar" },
  }));
  assert.equal(startEvs.length, 1);
  assert.equal(startEvs[0].type, "tool_use");
});

test("unparseable JSON falls back to stdout", () => {
  const evs = parseCodexLine("not json");
  assert.deepEqual(evs, [{ type: "stdout", line: "not json" }]);
});

// ─── Arg builders ───────────────────────────────────────────────────────

console.log("\n[arg builders]");

test("copilot args include --output-format json + --stream on", () => {
  const args = buildCopilotArgs({
    prompt: "hello",
    cwd: "/tmp",
  });
  assert.ok(args.includes("--output-format"));
  const i = args.indexOf("--output-format");
  assert.equal(args[i + 1], "json");
  assert.ok(args.includes("--stream"));
  assert.ok(args.includes("--allow-all-tools"));
  assert.ok(args.includes("--no-ask-user"));
  assert.ok(args.includes("--enable-reasoning-summaries"));
});

test("claude args include --output-format stream-json + --verbose", () => {
  const args = buildClaudeArgs({
    prompt: "hello",
    cwd: "/tmp",
  });
  assert.ok(args.includes("--output-format"));
  const i = args.indexOf("--output-format");
  assert.equal(args[i + 1], "stream-json");
  assert.ok(args.includes("--verbose"));
  assert.ok(args.includes("--include-partial-messages"));
  assert.ok(args.includes("--dangerously-skip-permissions"));
  // claude does NOT use copilot-only flags
  assert.ok(!args.includes("--allow-all-tools"));
  assert.ok(!args.includes("--enable-reasoning-summaries"));
});

test("copilot args respect --max-autopilot-continues", () => {
  const args = buildCopilotArgs({
    prompt: "x", cwd: "/tmp", maxAutopilotContinues: 42,
  });
  const i = args.indexOf("--max-autopilot-continues");
  assert.notEqual(i, -1);
  assert.equal(args[i + 1], "42");
});

test("claude maps maxAutopilotContinues to --max-turns", () => {
  const args = buildClaudeArgs({
    prompt: "x", cwd: "/tmp", maxAutopilotContinues: 42,
  });
  const i = args.indexOf("--max-turns");
  assert.notEqual(i, -1);
  assert.equal(args[i + 1], "42");
});

test("copilot --effort defaults to high", () => {
  const args = buildCopilotArgs({ prompt: "x", cwd: "/tmp" });
  const i = args.indexOf("--effort");
  assert.notEqual(i, -1);
  assert.equal(args[i + 1], "high");
});

test("copilot uses --autopilot instead of brittle --mode flag", () => {
  const args = buildCopilotArgs({ prompt: "x", cwd: "/tmp" });
  assert.ok(args.includes("--autopilot"));
  assert.ok(!args.includes("--mode"));
});

test("claude --effort defaults to high and maps xhigh → max", () => {
  const high = buildClaudeArgs({ prompt: "x", cwd: "/tmp" });
  let i = high.indexOf("--effort");
  assert.notEqual(i, -1);
  assert.equal(high[i + 1], "high");

  const maxed = buildClaudeArgs({ prompt: "x", cwd: "/tmp", reasoningEffort: "xhigh" });
  i = maxed.indexOf("--effort");
  assert.equal(maxed[i + 1], "max");
});

test("codex sets -c model_reasoning_effort=\"high\" by default", () => {
  const args = buildCodexArgs({ prompt: "x", cwd: "/tmp" });
  const i = args.indexOf("-c");
  assert.notEqual(i, -1);
  assert.equal(args[i + 1], 'model_reasoning_effort="high"');
});

test("default models are the 4.7/5.5 family", () => {
  const copArgs = buildCopilotArgs({ prompt: "x", cwd: "/tmp" });
  assert.equal(copArgs[copArgs.indexOf("--model") + 1], "claude-opus-4.7");

  const claArgs = buildClaudeArgs({ prompt: "x", cwd: "/tmp" });
  assert.equal(claArgs[claArgs.indexOf("--model") + 1], "claude-opus-4-7");

  const codArgs = buildCodexArgs({ prompt: "x", cwd: "/tmp" });
  assert.equal(codArgs[codArgs.indexOf("--model") + 1], "gpt-5.5-codex");
});

test("both builders accept --resume", () => {
  const copArgs = buildCopilotArgs({ prompt: "x", cwd: "/tmp", resumeSessionId: "sess_c" });
  const claArgs = buildClaudeArgs({ prompt: "x", cwd: "/tmp", resumeSessionId: "sess_d" });
  assert.ok(copArgs.includes("--resume"));
  assert.equal(copArgs[copArgs.indexOf("--resume") + 1], "sess_c");
  assert.ok(claArgs.includes("--resume"));
  assert.equal(claArgs[claArgs.indexOf("--resume") + 1], "sess_d");
});

test("codex args use `exec` subcommand with --json and prompt as positional", () => {
  const args = buildCodexArgs({
    prompt: "hello world",
    cwd: "/tmp",
  });
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(args.includes("--skip-git-repo-check"));
  // Prompt is last positional
  assert.equal(args[args.length - 1], "hello world");
  // Codex has no copilot/claude-specific flags
  assert.ok(!args.includes("--allow-all-tools"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

test("codex resume uses `exec resume <id>` subcommand chain", () => {
  const args = buildCodexArgs({
    prompt: "followup",
    cwd: "/tmp",
    resumeSessionId: "019dbf18-dead-beef",
  });
  assert.equal(args[0], "exec");
  assert.equal(args[1], "resume");
  assert.equal(args[2], "019dbf18-dead-beef");
  assert.equal(args[args.length - 1], "followup");
});

test("codex passes --add-dir per directory", () => {
  const args = buildCodexArgs({
    prompt: "x",
    cwd: "/tmp",
    addDirs: ["/tmp/a", "/tmp/b"],
  });
  const idx1 = args.indexOf("--add-dir");
  assert.notEqual(idx1, -1);
  assert.equal(args[idx1 + 1], "/tmp/a");
  const idx2 = args.indexOf("--add-dir", idx1 + 1);
  assert.notEqual(idx2, -1);
  assert.equal(args[idx2 + 1], "/tmp/b");
});

// ─── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
