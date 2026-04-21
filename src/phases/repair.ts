import type { MigrationContext, PhaseId } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import { PHASE_TITLES } from "../tui/bus.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import { runCopilotPhase } from "./theme.js";

export interface RepairOptions {
  phase: PhaseId;
  error: string;
  attempt: number;
}

/**
 * Invoke Copilot with the `repair` prompt to diagnose and fix the
 * failure of a single phase. Errors from Copilot are deliberately
 * swallowed — if the repair attempt itself fails we still want the
 * outer retry loop to re-run the failing phase; worst case we loop
 * back to the retry/skip/abort prompt with a fresh error.
 */
export async function runRepair(
  ctx: MigrationContext,
  bus: UiBus,
  opts: RepairOptions,
): Promise<void> {
  const { phase, error, attempt } = opts;
  bus.pushStreamEvent(phase, {
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
    RECENT_LOGS: bus.recentLogs(120, phase) || bus.recentLogs(120),
    SOURCE_KIND: ctx.detected?.kind ?? "unknown",
    DETECTOR_BRIEFING: ctx.detected?.detectorBriefing ?? "(none)",
    SOURCE_DIR: ctx.sourceDir,
    THEME_DIR: ctx.themeDir,
    PLUGIN_DIR: ctx.pluginDir,
    CONTENT_DIR: ctx.contentDir,
    WORK_DIR: ctx.workDir,
    WP_ENV_CONFIG: ctx.wpEnvConfigPath,
    WP_URL: ctx.wpUrl ?? "",
  });

  try {
    const result = await runCopilotPhase(bus, phase, {
      prompt,
      cwd: ctx.sourceDir,
      addDirs: [ctx.sourceDir, ctx.workDir, ctx.themeDir, ctx.pluginDir],
      resumeSessionId: ctx.copilotSessionId,
      maxAutopilotContinues: 30,
      timeoutMs: 10 * 60 * 1000,
    });
    if (result.sessionId) ctx.copilotSessionId = result.sessionId;
    bus.pushStreamEvent(phase, {
      type: "info",
      phase,
      message: `repair pass done — retrying ${PHASE_TITLES[phase]}`,
    });
  } catch (err) {
    bus.pushStreamEvent(phase, {
      type: "warn",
      phase,
      message: `repair pass failed (${(err as Error).message}) — retrying ${PHASE_TITLES[phase]} anyway`,
    });
  }
}
