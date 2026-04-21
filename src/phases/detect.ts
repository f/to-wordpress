import type { DetectedContext, MigrationContext } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import { runDetectors } from "../detectors/index.js";

/**
 * Detect phase. Tries every built-in detector and picks the highest-confidence
 * match. If no detector matches above threshold, falls back to the Copilot
 * freestyle detector, which always produces a context — we never skip a
 * folder, we always try to migrate.
 */
export async function runDetect(ctx: MigrationContext, bus: UiBus): Promise<DetectedContext> {
  bus.pushStreamEvent("detect", { type: "phase_start", phase: "detect", message: "scanning source" });
  const result = await runDetectors(ctx, bus);
  const ctxD = result.context;
  const postsCount = ctxD.collections.reduce((a, c) => a + c.count, 0);
  bus.pushStreamEvent("detect", {
    type: "info",
    phase: "detect",
    message: `kind=${ctxD.kind} via ${result.usedDetector}${result.ranFreestyle ? " (freestyle)" : ""}: layouts=${ctxD.layouts.length} includes=${ctxD.includes.length} collections=${ctxD.collections.length} posts=${postsCount} pages=${ctxD.pages.length}`,
  });
  if (
    ctxD.collections.length === 0 &&
    ctxD.pages.length === 0 &&
    ctxD.layouts.length === 0
  ) {
    bus.pushStreamEvent("detect", {
      type: "warn",
      phase: "detect",
      message: "inventory is empty — the migration will still run but there is nothing obvious to import",
    });
  }
  bus.pushStreamEvent("detect", { type: "phase_ok", phase: "detect" });
  return ctxD;
}
