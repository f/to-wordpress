import type { DetectedContext, MigrationContext, SsgKind } from "../types.js";
import type { UiBus } from "../tui/bus.js";

/**
 * A Detector identifies a known SSG/codebase shape and produces a DetectedContext.
 *
 * Lifecycle:
 * 1. `match(dir)` returns a confidence score in `[0, 1]`. 0 means "not this SSG".
 *    The detector with the highest non-zero score wins. If all return 0, the
 *    freestyle detector is used as the final fallback so we never skip a folder.
 * 2. `detect(ctx, bus)` produces the DetectedContext. Detectors should be
 *    conservative — missing pieces are fine, the freestyle detector can top them up.
 */
export interface Detector {
  readonly name: SsgKind;
  readonly priority?: number;
  match(dir: string): Promise<number>;
  detect(ctx: MigrationContext, bus: UiBus): Promise<DetectedContext>;
}

export interface DetectorRunResult {
  context: DetectedContext;
  usedDetector: string;
  ranFreestyle: boolean;
}
