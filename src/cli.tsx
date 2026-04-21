import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { App } from "./tui/App.js";
import { UiBus, PHASE_TITLES } from "./tui/bus.js";
import { attachHeadlessLogger } from "./tui/headless.js";
import type { MigrationContext, PhaseId } from "./types.js";
import { runDetect } from "./phases/detect.js";
import { runPlan } from "./phases/plan.js";
import { runBoot } from "./phases/boot.js";
import { runTheme } from "./phases/theme.js";
import { runPlugin } from "./phases/plugin.js";
import { runNormalize } from "./phases/normalize.js";
import { runImport } from "./phases/import.js";
import { runVerify } from "./phases/verify.js";
import { runFixLoop } from "./phases/fix.js";
import {
  applyContextToDoc,
  loadMigrationDoc,
  markPhase,
  saveMigrationDoc,
  type MigrationDoc,
} from "./state/migration.js";
import { runFresh } from "./phases/fresh.js";
import { commitPhase, setupGit } from "./phases/git.js";
import { computeEta } from "./phases/eta.js";
import { DEFAULT_COPILOT_MODEL, DEFAULT_COPILOT_EFFORT } from "./copilot/run.js";
import type { PhaseStatus } from "./types.js";

const PACKAGE_VERSION = "0.1.2";

interface CliOptions {
  skipBoot?: boolean;
  skipCopilot?: boolean;
  only?: string;
  from?: PhaseId;
  until?: PhaseId;
  maxFixIterations?: number;
  yes?: boolean;
  fresh?: boolean;
  branch?: string;
  git?: boolean;
}

const PHASE_ORDER: PhaseId[] = [
  "detect",
  "plan",
  "boot",
  "theme",
  "plugin",
  "normalize",
  "import",
  "verify",
  "fix",
];

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("to-wordpress")
    .description("Migrate any codebase to WordPress. Hybrid orchestration with GitHub Copilot CLI.")
    .version(PACKAGE_VERSION, "-v, --version", "print version")
    .argument("[source]", "path to the source site to migrate", ".")
    .option("--fresh", "tear down previous wp-env containers + volumes and wipe WORDPRESS_MIGRATION/ before starting")
    .option("--branch <name>", "git branch to create and commit migration work on", "to-wordpress")
    .option("--no-git", "disable automatic git init / branching / per-phase commits")
    .option("--skip-boot", "skip wp-env start (assumes already running)")
    .option("--skip-copilot", "use deterministic fallbacks only, don't invoke copilot")
    .option("-y, --yes", "auto-answer all user prompts with defaults (non-interactive)")
    .option("--only <phase>", "run only this phase (skips all others; not recommended across invocations)")
    .option("--from <phase>", "start from this phase (skip earlier ones)")
    .option("--until <phase>", "stop after this phase (skip later ones)")
    .option("--max-fix-iterations <n>", "max Verify→Fix iterations", (v) => Number(v), 3)
    .parse(process.argv);

  const opts = program.opts<CliOptions>();
  const sourceArg = program.args[0] ?? ".";
  const sourceDir = resolve(process.cwd(), sourceArg);

  const workDir = join(sourceDir, "WORDPRESS_MIGRATION");
  const ctx: MigrationContext = {
    sourceDir,
    workDir,
    planPath: join(sourceDir, "WORDPRESS_MIGRATION.md"),
    wpEnvConfigPath: join(sourceDir, ".wp-env.json"),
    themeDir: join(workDir, "theme"),
    pluginDir: join(workDir, "plugin"),
    contentDir: join(workDir, "content"),
    mediaDir: join(workDir, "media"),
    flags: {
      skipBoot: Boolean(opts.skipBoot),
      skipCopilot: Boolean(opts.skipCopilot),
      yes: Boolean(opts.yes),
      fresh: Boolean(opts.fresh),
    },
  };

  await mkdir(workDir, { recursive: true });
  await mkdir(ctx.themeDir, { recursive: true });
  await mkdir(ctx.pluginDir, { recursive: true });

  const bus = new UiBus();
  bus.autoAnswer = Boolean(opts.yes);

  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const headless = !isTty || Boolean(opts.yes);
  let detachHeadless: (() => void) | undefined;
  let ui: ReturnType<typeof render> | undefined;
  if (headless) {
    detachHeadless = attachHeadlessLogger(bus, sourceDir);
  } else {
    ui = render(
      <App
        bus={bus}
        sourceDir={sourceDir}
        phaseOrder={PHASE_ORDER}
        onExit={() => {
          ui?.unmount();
          process.exit(0);
        }}
      />,
    );
  }

  const filter = (phase: PhaseId): boolean => {
    if (opts.only) return phase === opts.only;
    const idx = PHASE_ORDER.indexOf(phase);
    if (opts.from && idx < PHASE_ORDER.indexOf(opts.from)) return false;
    if (opts.until && idx > PHASE_ORDER.indexOf(opts.until)) return false;
    return true;
  };

  if (opts.fresh && (opts.from || opts.only)) {
    bus.pushStreamEvent(undefined, {
      type: "error",
      message: "--fresh cannot be combined with --from or --only (fresh wipes state that those flags depend on)",
    });
    bus.emit("done", 2);
    if (headless) {
      detachHeadless?.();
      process.exit(2);
    }
    return;
  }

  const gitEnabled = opts.git !== false;

  // Announce which Copilot model will do the creative work. Users asked to
  // see this up front so surprises about quality/latency are off the table.
  if (!opts.skipCopilot) {
    bus.pushStreamEvent(undefined, {
      type: "info",
      phase: "detect",
      message: `Copilot model: ${DEFAULT_COPILOT_MODEL} · effort: ${DEFAULT_COPILOT_EFFORT} (override with --model / COPILOT_MODEL, --effort / COPILOT_EFFORT)`,
    });
  }

  let exitCode = 0;
  try {
    if (opts.fresh) {
      await runFresh(ctx, bus);
    }

    if (gitEnabled) {
      await setupGit(ctx, bus, opts.branch ?? "to-wordpress");
    }

    const doc = await loadMigrationDoc(ctx.planPath, ctx.sourceDir);
    if (doc.detected) ctx.detected = doc.detected;
    if (doc.choices) ctx.choices = doc.choices;
    if (doc.copilotSessionId) ctx.copilotSessionId = doc.copilotSessionId;
    // A phase marked "running" means a prior invocation died mid-phase
    // (Ctrl-C, crash, etc.). Reset those to "pending" so resume mode
    // re-runs them instead of treating them as complete or blocking.
    for (const id of Object.keys(doc.phases) as PhaseId[]) {
      if (doc.phases[id].status === "running") {
        doc.phases[id].status = "pending";
        doc.phases[id].notes = "recovered from interrupted run";
      }
    }
    await hydrateWpUrl(ctx);

    // If the user explicitly re-targeted phases via --from/--only/--until
    // we honor those exactly. Otherwise, auto-resume: any phase already
    // marked "ok" in WORDPRESS_MIGRATION.md is skipped so we pick up
    // where the last run left off instead of redoing detection,
    // theme/plugin generation, normalization, etc.
    const explicitRange = Boolean(opts.from || opts.only || opts.until);
    const resumeMode = !explicitRange && !opts.fresh;
    if (resumeMode) {
      const completed = (Object.keys(doc.phases) as PhaseId[]).filter(
        (id) => doc.phases[id].status === "ok",
      );
      if (completed.length > 0) {
        bus.pushStreamEvent(undefined, {
          type: "info",
          phase: "detect",
          message: `resuming from prior run — skipping already-completed phases: ${completed.join(", ")} (pass --fresh to start over, --from <phase> to force a specific rerun)`,
        });
      }
    }

    const step = async <T,>(
      phase: PhaseId,
      condition: boolean,
      run: () => Promise<T>,
    ): Promise<T | undefined> => {
      if (!condition || !filter(phase)) return undefined;
      if (resumeMode && doc.phases[phase]?.status === "ok") {
        bus.pushStreamEvent(undefined, {
          type: "info",
          phase,
          message: `${PHASE_TITLES[phase]}: already complete, skipping (resume)`,
        });
        return undefined;
      }
      return runPhaseStep(ctx, bus, doc, phase, gitEnabled, run);
    };

    await step("detect", true, async () => {
      ctx.detected = await runDetect(ctx, bus);
    });
    await step("plan", true, async () => {
      ctx.choices = await runPlan(ctx, bus);
    });
    await step("boot", !opts.skipBoot, async () => {
      await runBoot(ctx, bus);
    });
    await step("theme", !opts.skipCopilot, async () => {
      await runTheme(ctx, bus);
    });
    await step("plugin", !opts.skipCopilot, async () => {
      await runPlugin(ctx, bus);
    });
    await step("normalize", true, async () => {
      await runNormalize(ctx, bus);
    });
    await step("import", true, async () => {
      await runImport(ctx, bus);
    });
    const report = await step("verify", true, async () => runVerify(ctx, bus));
    if (report && !report.ok && !opts.skipCopilot) {
      const final = await step("fix", true, async () =>
        runFixLoop(ctx, bus, report, { maxIterations: opts.maxFixIterations }),
      );
      if (final && !final.ok) exitCode = 2;
    }
  } catch (err) {
    bus.pushStreamEvent(undefined, { type: "error", message: (err as Error).message });
    exitCode = 1;
  }

  bus.emit("done", exitCode);
  if (headless) {
    detachHeadless?.();
    process.exit(exitCode);
  }
}

/**
 * Run a single phase with retry/skip/abort support. On failure, the user is
 * prompted to retry (re-run the phase), skip (mark as failed and continue),
 * or abort (throw). Under `--yes` a failure aborts immediately.
 *
 * On success (or skip) we stage + commit whatever the phase wrote to the
 * source tree under the `to-wordpress` branch so each phase is a standalone
 * checkpoint you can `git diff` against the previous one.
 */
async function runPhaseStep<T>(
  ctx: MigrationContext,
  bus: UiBus,
  doc: MigrationDoc,
  phase: PhaseId,
  gitEnabled: boolean,
  run: () => Promise<T>,
): Promise<T | undefined> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      markPhase(doc, phase, "running");
      await saveAndApply(ctx, doc, `started ${phase}`, bus);
      const result = await run();
      markPhase(doc, phase, "ok");
      await saveAndApply(ctx, doc, `finished ${phase}`, bus);
      if (gitEnabled) await commitPhase(ctx, phase, bus, { active: true });
      return result;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      bus.pushStreamEvent(undefined, {
        type: "error",
        message: `${PHASE_TITLES[phase]} failed (attempt ${attempt}): ${msg}`,
      });
      markPhase(doc, phase, "fail", msg);
      await saveAndApply(ctx, doc, `failed ${phase}`, bus);

      if (ctx.flags.yes) throw err;

      const ans = await bus.askPrompt({
        id: `phase-fail-${phase}-${attempt}`,
        title: `${PHASE_TITLES[phase]} failed`,
        kind: "select",
        message: `Attempt ${attempt} error: ${truncate(msg, 200)}. What do you want to do?`,
        options: [
          { label: "Retry this phase", value: "retry" },
          { label: "Skip and continue", value: "skip" },
          { label: "Abort migration", value: "abort" },
        ],
        default: "retry",
      });
      if (ans === "retry") {
        bus.pushStreamEvent(undefined, { type: "info", phase, message: `retrying ${phase}…` });
        continue;
      }
      if (ans === "skip") {
        markPhase(doc, phase, "skipped", `user skipped after ${attempt} attempt${attempt === 1 ? "" : "s"}`);
        // Persist the skip decision BEFORE the next phase starts so a
        // subsequent crash (or Ctrl-C) still reflects the correct state.
        try {
          await saveAndApply(ctx, doc, `skipped ${phase}`, bus);
        } catch (saveErr) {
          bus.pushStreamEvent(undefined, {
            type: "warn",
            phase,
            message: `could not save state after skipping ${phase}: ${(saveErr as Error).message}`,
          });
        }
        if (gitEnabled) {
          try {
            await commitPhase(ctx, `${phase} (skipped)`, bus, { active: true });
          } catch (gitErr) {
            bus.pushStreamEvent(undefined, {
              type: "warn",
              phase,
              message: `git commit after skip failed: ${(gitErr as Error).message} — continuing`,
            });
          }
        }
        bus.pushStreamEvent(undefined, {
          type: "info",
          phase,
          message: `${PHASE_TITLES[phase]} skipped — continuing with the next phase`,
        });
        return undefined;
      }
      if (ans === "abort") {
        bus.pushStreamEvent(undefined, {
          type: "info",
          phase,
          message: `${PHASE_TITLES[phase]} aborted by user`,
        });
        throw err;
      }
      // Unknown response (e.g. prompt torn down by shutdown) — treat as abort.
      throw err;
    }
  }
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

async function hydrateWpUrl(ctx: MigrationContext): Promise<void> {
  if (ctx.wpUrl) return;
  if (!existsSync(ctx.wpEnvConfigPath)) return;
  try {
    const cfg = JSON.parse(await readFile(ctx.wpEnvConfigPath, "utf8")) as { port?: number };
    ctx.wpUrl = `http://localhost:${cfg.port ?? 8888}`;
  } catch {
    ctx.wpUrl = "http://localhost:8888";
  }
}

async function saveAndApply(
  ctx: MigrationContext,
  doc: MigrationDoc,
  note: string,
  bus?: UiBus,
): Promise<void> {
  applyContextToDoc(doc, ctx);
  await saveMigrationDoc(ctx.planPath, doc, [
    {
      heading: "Status",
      body: `${note} at ${new Date().toISOString()}`,
    },
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
