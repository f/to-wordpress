import type { MigrationContext } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import { runCopilotPhase } from "./theme.js";
import { runVerify, type VerifyReport } from "./verify.js";

export interface FixOptions {
  maxIterations?: number;
}

export async function runFixLoop(
  ctx: MigrationContext,
  bus: UiBus,
  initialReport: VerifyReport,
  opts: FixOptions = {},
): Promise<VerifyReport> {
  const maxIter = opts.maxIterations ?? 3;
  let report = initialReport;
  let iter = 0;
  while (!report.ok && iter < maxIter) {
    iter++;
    bus.pushStreamEvent("fix", {
      type: "phase_start",
      phase: "fix",
      message: `iteration ${iter}/${maxIter}: ${report.issues.length} issue${report.issues.length === 1 ? "" : "s"}`,
    });

    const tpl = await loadPrompt("fix");
    const prompt = interpolate(tpl, {
      VERIFY_REPORT_JSON: JSON.stringify(report, null, 2),
      THEME_DIR: ctx.themeDir,
      PLUGIN_DIR: ctx.pluginDir,
      CONTENT_DIR: ctx.contentDir,
      SOURCE_DIR: ctx.sourceDir,
      WP_URL: ctx.wpUrl ?? "",
    });

    const result = await runCopilotPhase(bus, "fix", {
      prompt,
      cwd: ctx.sourceDir,
      addDirs: [ctx.sourceDir, ctx.workDir, ctx.themeDir, ctx.pluginDir],
      resumeSessionId: ctx.copilotSessionId,
      maxAutopilotContinues: 60,
      timeoutMs: 15 * 60 * 1000,
    });
    if (result.sessionId) ctx.copilotSessionId = result.sessionId;

    bus.pushStreamEvent("fix", { type: "info", phase: "fix", message: "re-running verify" });
    report = await runVerify(ctx, bus);
  }
  if (report.ok) {
    bus.pushStreamEvent("fix", { type: "phase_ok", phase: "fix", message: `clean after ${iter} fix iteration${iter === 1 ? "" : "s"}` });
  } else {
    bus.pushStreamEvent("fix", {
      type: "phase_fail",
      phase: "fix",
      message: `${report.issues.length} issue${report.issues.length === 1 ? "" : "s"} remain after ${iter} iterations`,
    });
  }
  return report;
}
