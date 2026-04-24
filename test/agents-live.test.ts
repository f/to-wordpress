/**
 * LIVE smoke test: spawn each agent CLI and verify the event stream works
 * end-to-end. Requires both `copilot` and `claude` binaries on $PATH and
 * valid authentication. Skipped gracefully if either is missing.
 *
 * Run via: npx tsx test/agents-live.test.ts
 */
import { execa } from "execa";
import { runCopilot } from "../src/agents/index.ts";
import type { CopilotEvent } from "../src/types.ts";

async function haveBinary(name: string): Promise<boolean> {
  try {
    await execa("which", [name], { reject: true });
    return true;
  } catch {
    return false;
  }
}

async function smokeTest(agent: "copilot" | "claude" | "codex"): Promise<void> {
  console.log(`\n[live: ${agent}]`);
  const events: CopilotEvent[] = [];
  const iter = runCopilot({
    agent,
    prompt: "Reply with exactly the three words: ready set go",
    cwd: process.cwd(),
    maxAutopilotContinues: 1,
    timeoutMs: 60_000,
  });

  let assistantText = "";
  let sessionSeen = false;
  let exitCode = -1;
  try {
    while (true) {
      const next = await iter.next();
      if (next.done) {
        exitCode = next.value.exitCode;
        break;
      }
      const ev = next.value;
      events.push(ev);
      if (ev.type === "session") sessionSeen = true;
      if (ev.type === "message" && ev.role === "assistant") {
        assistantText += ev.text;
      }
      // Log some progress so we can see it's working
      if (events.length % 5 === 0) {
        process.stdout.write(".");
      }
    }
  } catch (err) {
    console.error(`  FAIL: ${(err as Error).message}`);
    throw err;
  }

  console.log("");
  console.log(`  events: ${events.length}`);
  console.log(`  session seen: ${sessionSeen}`);
  console.log(`  exit code: ${exitCode}`);
  console.log(`  assistant text: ${assistantText.slice(0, 120).replace(/\n/g, " ")}`);

  if (exitCode !== 0) throw new Error(`${agent} exited ${exitCode}`);
  if (!assistantText.trim()) throw new Error(`${agent} produced no assistant text`);
  if (!sessionSeen) console.warn(`  WARN: no session event from ${agent}`);
}

(async () => {
  let failed = 0;

  for (const agent of ["copilot", "claude", "codex"] as const) {
    if (!(await haveBinary(agent))) {
      console.log(`\n[live: ${agent}] SKIP — binary not found on $PATH`);
      continue;
    }
    try {
      await smokeTest(agent);
      console.log(`  ok`);
    } catch (err) {
      console.error(`  FAIL: ${(err as Error).message}`);
      failed++;
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} live smoke test(s) failed`);
    process.exit(1);
  }
  console.log(`\nall live smoke tests passed`);
})();
