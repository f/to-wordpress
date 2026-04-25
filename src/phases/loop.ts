import type { MigrationContext, PhaseId, LoopStage } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import { PHASE_TITLES } from "../tui/bus.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import { runCopilotPhase } from "./theme.js";
import {
  markPhase,
  saveMigrationDoc,
  applyContextToDoc,
  type MigrationDoc,
} from "../state/migration.js";
import { commitPhase } from "./git.js";
import type { PhaseStatus } from "../types.js";
import { computeEta } from "./eta.js";

export type FailStrategy = "abort" | "skip" | "continue";

/**
 * Every phase implements this interface to plug into the generic
 * attempt-test-fix loop. `TReport` is the phase-specific test result
 * (e.g. VerifyReport, EndpointTestReport, or a simple boolean wrapper).
 */
export interface PhaseLoop<TReport> {
  phase: PhaseId;

  /** Run the phase's core work (what used to be the entire phase function). */
  attempt: () => Promise<void>;

  /**
   * Validate the phase output. Called after every successful attempt and
   * after every fix pass. Return a report whose shape is phase-specific.
   */
  test: () => Promise<TReport>;

  /** Determine if the test report represents success. */
  isOk: (report: TReport) => boolean;

  /** Describe failures from the report for logging. */
  describeIssues: (report: TReport) => string;

  /**
   * Build the Copilot prompt for fixing test failures. Return undefined to
   * skip Copilot-based fixing for this phase (falls back to re-attempt).
   */
  buildFixPrompt: (report: TReport, pass: number) => Promise<string | undefined>;

  /** Copilot options for the fix invocation. */
  copilotFixOpts?: () => {
    addDirs: string[];
    maxAutopilotContinues: number;
    timeoutMs: number;
  };

  /** Whether this phase should be skipped (e.g. --skip-boot, --skip-copilot). */
  skip?: boolean;
}

export interface AgenticLoopOptions {
  maxAttempts: number;
  maxFixPasses: number;
  failStrategy: FailStrategy;
  gitEnabled: boolean;
  skipCopilot: boolean;
}

interface LoopContext {
  ctx: MigrationContext;
  bus: UiBus;
  doc: MigrationDoc;
  opts: AgenticLoopOptions;
}

function emitLoopStatus(
  bus: UiBus,
  phase: PhaseId,
  attempt: number,
  maxAttempts: number,
  fixPass: number,
  maxFixPasses: number,
  stage: LoopStage,
): void {
  bus.pushStreamEvent(phase, {
    type: "loop_status",
    phase,
    attempt,
    maxAttempts,
    fixPass,
    maxFixPasses,
    stage,
  });
}

async function saveAndApply(
  ctx: MigrationContext,
  doc: MigrationDoc,
  note: string,
  bus?: UiBus,
): Promise<void> {
  applyContextToDoc(doc, ctx);
  await saveMigrationDoc(ctx.planPath, doc, [
    { heading: "Status", body: `${note} at ${new Date().toISOString()}` },
  ]);
  if (bus && ctx.detected) {
    const statuses: Partial<Record<PhaseId, PhaseStatus>> = {};
    for (const [id, entry] of Object.entries(doc.phases)) {
      statuses[id as PhaseId] = entry.status as PhaseStatus;
    }
    const snap = computeEta(ctx, statuses);
    bus.emit("eta", {
      totalSeconds: snap.totalSeconds,
      remainingSeconds: snap.remainingSeconds,
      active: snap.active,
    });
  }
}

async function runRepairInline(
  lc: LoopContext,
  phase: PhaseId,
  error: string,
  attempt: number,
): Promise<void> {
  if (lc.opts.skipCopilot) {
    lc.bus.pushStreamEvent(phase, {
      type: "info",
      phase,
      message: `retrying ${PHASE_TITLES[phase]}… (copilot disabled)`,
    });
    return;
  }

  lc.bus.pushStreamEvent(phase, {
    type: "info",
    phase,
    message: `asking Copilot to diagnose & patch ${PHASE_TITLES[phase]} before retry #${attempt + 1}`,
  });

  const tpl = await loadPrompt("repair");
  const prompt = interpolate(tpl, {
    PHASE: phase,
    PHASE_TITLE: PHASE_TITLES[phase],
    ATTEMPT: String(attempt),
    ERROR_MESSAGE: error,
    RECENT_LOGS: lc.bus.recentLogs(120, phase) || lc.bus.recentLogs(120),
    SOURCE_KIND: lc.ctx.detected?.kind ?? "unknown",
    DETECTOR_BRIEFING: lc.ctx.detected?.detectorBriefing ?? "(none)",
    SOURCE_DIR: lc.ctx.sourceDir,
    THEME_DIR: lc.ctx.themeDir,
    PLUGIN_DIR: lc.ctx.pluginDir,
    CONTENT_DIR: lc.ctx.contentDir,
    WORK_DIR: lc.ctx.workDir,
    WP_ENV_CONFIG: lc.ctx.wpEnvConfigPath,
    WP_URL: lc.ctx.wpUrl ?? "",
  });

  try {
    const result = await runCopilotPhase(lc.bus, phase, {
      prompt,
      cwd: lc.ctx.sourceDir,
      addDirs: [lc.ctx.sourceDir, lc.ctx.workDir, lc.ctx.themeDir, lc.ctx.pluginDir],
      resumeSessionId: lc.ctx.copilotSessionId,
      maxAutopilotContinues: 30,
      timeoutMs: 10 * 60 * 1000,
    });
    if (result.sessionId) lc.ctx.copilotSessionId = result.sessionId;
    lc.bus.pushStreamEvent(phase, {
      type: "info",
      phase,
      message: `repair pass done — retrying ${PHASE_TITLES[phase]}`,
    });
  } catch (err) {
    lc.bus.pushStreamEvent(phase, {
      type: "warn",
      phase,
      message: `repair pass failed (${(err as Error).message}) — retrying ${PHASE_TITLES[phase]} anyway`,
    });
  }
}

/**
 * Run a phase through the full agentic loop:
 *   1. attempt() — run the phase
 *   2. test() — check if the output is correct
 *   3. If test fails and iterations remain: fix via Copilot, then back to 1
 *   4. If attempt() throws: repair via Copilot, then back to 1
 *
 * No user prompts. Everything is parametric.
 */
export async function runAgenticLoop<TReport>(
  ctx: MigrationContext,
  bus: UiBus,
  doc: MigrationDoc,
  loop: PhaseLoop<TReport>,
  opts: AgenticLoopOptions,
): Promise<TReport | undefined> {
  const lc: LoopContext = { ctx, bus, doc, opts };
  const { phase } = loop;

  if (loop.skip) {
    bus.pushStreamEvent(phase, {
      type: "info",
      phase,
      message: `${PHASE_TITLES[phase]}: skipped by configuration`,
    });
    markPhase(doc, phase, "skipped", "skipped by configuration");
    await saveAndApply(ctx, doc, `skipped ${phase}`, bus);
    return undefined;
  }

  let lastReport: TReport | undefined;
  let fixPass = 0;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    emitLoopStatus(bus, phase, attempt, opts.maxAttempts, fixPass, opts.maxFixPasses, "attempting");
    bus.pushStreamEvent(phase, {
      type: "phase_start",
      phase,
      message: `${PHASE_TITLES[phase]} — attempt ${attempt}/${opts.maxAttempts}`,
    });

    try {
      markPhase(doc, phase, "running");
      await saveAndApply(ctx, doc, `started ${phase} attempt ${attempt}`, bus);
      await loop.attempt();
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      bus.pushStreamEvent(phase, {
        type: "warn",
        phase,
        message: `${PHASE_TITLES[phase]} crashed (attempt ${attempt}/${opts.maxAttempts}): ${truncate(msg, 200)}`,
      });

      if (attempt < opts.maxAttempts) {
        emitLoopStatus(bus, phase, attempt, opts.maxAttempts, fixPass, opts.maxFixPasses, "repairing");
        await runRepairInline(lc, phase, msg, attempt);
        continue;
      }

      markPhase(doc, phase, "fail", msg);
      await saveAndApply(ctx, doc, `failed ${phase}`, bus);
      bus.pushStreamEvent(phase, {
        type: "phase_fail",
        phase,
        message: `${PHASE_TITLES[phase]} failed after ${attempt} attempt(s): ${truncate(msg, 200)}`,
      });

      if (opts.failStrategy === "abort") throw err;
      if (opts.failStrategy === "skip") return undefined;
      return undefined;
    }

    // Phase succeeded (no throw). Now test.
    emitLoopStatus(bus, phase, attempt, opts.maxAttempts, fixPass, opts.maxFixPasses, "testing");
    bus.pushStreamEvent(phase, {
      type: "info",
      phase,
      message: `testing ${PHASE_TITLES[phase]} output`,
    });

    try {
      lastReport = await loop.test();
    } catch (testErr) {
      bus.pushStreamEvent(phase, {
        type: "warn",
        phase,
        message: `test for ${PHASE_TITLES[phase]} threw: ${(testErr as Error).message} — treating as fail`,
      });
      lastReport = undefined as unknown as TReport;
      if (attempt < opts.maxAttempts) {
        emitLoopStatus(bus, phase, attempt, opts.maxAttempts, fixPass, opts.maxFixPasses, "repairing");
        await runRepairInline(lc, phase, (testErr as Error).message, attempt);
        continue;
      }
      break;
    }

    if (loop.isOk(lastReport)) {
      markPhase(doc, phase, "ok");
      await saveAndApply(ctx, doc, `finished ${phase}`, bus);
      bus.pushStreamEvent(phase, {
        type: "phase_ok",
        phase,
        message: `${PHASE_TITLES[phase]} passed on attempt ${attempt}`,
      });
      if (opts.gitEnabled) {
        try {
          await commitPhase(ctx, phase, bus, { active: true });
        } catch {
          // git commit failure is non-fatal
        }
      }
      return lastReport;
    }

    // Test failed — enter fix loop
    const issues = loop.describeIssues(lastReport);
    bus.pushStreamEvent(phase, {
      type: "info",
      phase,
      message: `${PHASE_TITLES[phase]} test found issues: ${truncate(issues, 300)}`,
    });

    let fixed = false;
    for (fixPass = 1; fixPass <= opts.maxFixPasses; fixPass++) {
      if (opts.skipCopilot) break;

      emitLoopStatus(bus, phase, attempt, opts.maxAttempts, fixPass, opts.maxFixPasses, "fixing");
      bus.pushStreamEvent(phase, {
        type: "info",
        phase,
        message: `fix pass ${fixPass}/${opts.maxFixPasses} for ${PHASE_TITLES[phase]}`,
      });

      const fixPrompt = await loop.buildFixPrompt(lastReport, fixPass);
      if (!fixPrompt) break;

      const fixOpts = loop.copilotFixOpts?.() ?? {
        addDirs: [ctx.sourceDir, ctx.workDir, ctx.themeDir, ctx.pluginDir],
        maxAutopilotContinues: 60,
        timeoutMs: 15 * 60 * 1000,
      };

      try {
        const result = await runCopilotPhase(bus, phase, {
          prompt: fixPrompt,
          cwd: ctx.sourceDir,
          addDirs: fixOpts.addDirs,
          resumeSessionId: ctx.copilotSessionId,
          maxAutopilotContinues: fixOpts.maxAutopilotContinues,
          timeoutMs: fixOpts.timeoutMs,
        });
        if (result.sessionId) ctx.copilotSessionId = result.sessionId;
        if (result.exitCode !== 0) {
          bus.pushStreamEvent(phase, {
            type: "warn",
            phase,
            message: `fix pass ${fixPass} agent exited ${result.exitCode}; skipping re-test for this pass`,
          });
          continue;
        }
      } catch (fixErr) {
        bus.pushStreamEvent(phase, {
          type: "warn",
          phase,
          message: `fix pass ${fixPass} failed: ${(fixErr as Error).message}`,
        });
        continue;
      }

      // Re-test after fix
      emitLoopStatus(bus, phase, attempt, opts.maxAttempts, fixPass, opts.maxFixPasses, "testing");
      try {
        lastReport = await loop.test();
      } catch (retestErr) {
        bus.pushStreamEvent(phase, {
          type: "warn",
          phase,
          message: `re-test after fix threw: ${(retestErr as Error).message}`,
        });
        continue;
      }

      if (loop.isOk(lastReport)) {
        fixed = true;
        break;
      }

      bus.pushStreamEvent(phase, {
        type: "info",
        phase,
        message: `still failing after fix pass ${fixPass}: ${truncate(loop.describeIssues(lastReport), 200)}`,
      });
    }

    if (fixed || loop.isOk(lastReport)) {
      markPhase(doc, phase, "ok");
      await saveAndApply(ctx, doc, `finished ${phase} (fixed)`, bus);
      bus.pushStreamEvent(phase, {
        type: "phase_ok",
        phase,
        message: `${PHASE_TITLES[phase]} passed after ${fixPass} fix pass(es)`,
      });
      if (opts.gitEnabled) {
        try {
          await commitPhase(ctx, phase, bus, { active: true });
        } catch {
          // non-fatal
        }
      }
      return lastReport;
    }

    // Fix loop exhausted — try another full attempt if we have budget
    if (attempt < opts.maxAttempts) {
      bus.pushStreamEvent(phase, {
        type: "info",
        phase,
        message: `fix loop exhausted for attempt ${attempt} — re-attempting ${PHASE_TITLES[phase]}`,
      });
      emitLoopStatus(bus, phase, attempt, opts.maxAttempts, fixPass, opts.maxFixPasses, "repairing");
      await runRepairInline(lc, phase, `test failed: ${truncate(issues, 200)}`, attempt);
      fixPass = 0;
      continue;
    }
  }

  // All attempts exhausted
  const finalMsg = lastReport
    ? `${PHASE_TITLES[phase]} still failing after all attempts: ${truncate(loop.describeIssues(lastReport), 200)}`
    : `${PHASE_TITLES[phase]} failed after all attempts`;

  markPhase(doc, phase, "fail", finalMsg);
  await saveAndApply(ctx, doc, `failed ${phase}`, bus);
  bus.pushStreamEvent(phase, { type: "phase_fail", phase, message: finalMsg });

  if (opts.gitEnabled) {
    try {
      await commitPhase(ctx, `${phase} (failed)`, bus, { active: true });
    } catch {
      // non-fatal
    }
  }

  if (opts.failStrategy === "abort") {
    throw new Error(finalMsg);
  }

  return lastReport;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}
