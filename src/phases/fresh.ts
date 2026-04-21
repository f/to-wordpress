import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { MigrationContext } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import { wpEnvDestroy } from "../wp/wpEnv.js";

/**
 * --fresh: tear down everything we previously wrote so the next run starts
 * from a truly clean slate. Safe to call even when nothing exists yet.
 *
 * Steps:
 *   1. If a `.wp-env.json` is present, run `wp-env destroy` (pipes "y" to any
 *      confirmation prompts) — this drops containers, volumes, and the
 *      WordPress database.
 *   2. Remove `WORDPRESS_MIGRATION/` (theme + plugin + content + rendered +
 *      manifests).
 *   3. Remove `WORDPRESS_MIGRATION.md` (plan doc with embedded state block).
 *   4. Remove `.wp-env.json` so Boot regenerates it cleanly.
 */
export async function runFresh(ctx: MigrationContext, bus: UiBus): Promise<void> {
  bus.pushStreamEvent(undefined, {
    type: "info",
    phase: "detect",
    message: "--fresh: tearing down previous wp-env state and migration outputs",
  });

  if (existsSync(ctx.wpEnvConfigPath)) {
    bus.pushStreamEvent(undefined, {
      type: "info",
      phase: "detect",
      message: "fresh: running wp-env destroy",
    });
    try {
      const exit = await wpEnvDestroy({
        cwd: ctx.sourceDir,
        timeoutMs: 5 * 60 * 1000,
        onLine: (line, stream) => {
          if (stream === "stderr") bus.pushStreamEvent(undefined, { type: "stderr", line });
          else bus.pushStreamEvent(undefined, { type: "info", phase: "detect", message: line });
        },
      });
      if (exit !== 0) {
        bus.pushStreamEvent(undefined, {
          type: "warn",
          phase: "detect",
          message: `fresh: wp-env destroy exited ${exit} (usually fine if nothing was running)`,
        });
      }
    } catch (err) {
      bus.pushStreamEvent(undefined, {
        type: "warn",
        phase: "detect",
        message: `fresh: wp-env destroy threw: ${(err as Error).message}`,
      });
    }
  }

  for (const p of [ctx.workDir, ctx.planPath, ctx.wpEnvConfigPath]) {
    if (!existsSync(p)) continue;
    try {
      await rm(p, { recursive: true, force: true });
      bus.pushStreamEvent(undefined, {
        type: "info",
        phase: "detect",
        message: `fresh: removed ${p}`,
      });
    } catch (err) {
      bus.pushStreamEvent(undefined, {
        type: "warn",
        phase: "detect",
        message: `fresh: could not remove ${p}: ${(err as Error).message}`,
      });
    }
  }
}
