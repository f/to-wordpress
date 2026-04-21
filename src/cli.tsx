import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { App } from "./tui/App.js";
import { UiBus } from "./tui/bus.js";
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
import { applyContextToDoc, loadMigrationDoc, markPhase, saveMigrationDoc } from "./state/migration.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const PACKAGE_VERSION = "0.1.1";

interface CliOptions {
  skipBoot?: boolean;
  skipCopilot?: boolean;
  only?: string;
  from?: PhaseId;
  until?: PhaseId;
  maxFixIterations?: number;
  yes?: boolean;
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

  let exitCode = 0;
  try {
    const doc = await loadMigrationDoc(ctx.planPath, ctx.sourceDir);
    if (doc.detected) ctx.detected = doc.detected;
    if (doc.choices) ctx.choices = doc.choices;
    if (doc.copilotSessionId) ctx.copilotSessionId = doc.copilotSessionId;
    await hydrateWpUrl(ctx);

    if (filter("detect")) {
      markPhase(doc, "detect", "running");
      ctx.detected = await runDetect(ctx, bus);
      markPhase(doc, "detect", "ok");
      await saveAndApply(ctx, doc, "after detect");
    }

    if (filter("plan")) {
      markPhase(doc, "plan", "running");
      ctx.choices = await runPlan(ctx, bus);
      markPhase(doc, "plan", "ok");
      await saveAndApply(ctx, doc, "after plan");
    }

    if (filter("boot") && !opts.skipBoot) {
      markPhase(doc, "boot", "running");
      await runBoot(ctx, bus);
      markPhase(doc, "boot", "ok");
      await saveAndApply(ctx, doc, "after boot");
    }

    if (filter("theme") && !opts.skipCopilot) {
      markPhase(doc, "theme", "running");
      await runTheme(ctx, bus);
      markPhase(doc, "theme", "ok");
      await saveAndApply(ctx, doc, "after theme");
    }

    if (filter("plugin") && !opts.skipCopilot) {
      markPhase(doc, "plugin", "running");
      await runPlugin(ctx, bus);
      markPhase(doc, "plugin", "ok");
      await saveAndApply(ctx, doc, "after plugin");
    }

    if (filter("normalize")) {
      markPhase(doc, "normalize", "running");
      await runNormalize(ctx, bus);
      markPhase(doc, "normalize", "ok");
      await saveAndApply(ctx, doc, "after normalize");
    }

    if (filter("import")) {
      markPhase(doc, "import", "running");
      await runImport(ctx, bus);
      markPhase(doc, "import", "ok");
      await saveAndApply(ctx, doc, "after import");
    }

    let report;
    if (filter("verify")) {
      markPhase(doc, "verify", "running");
      report = await runVerify(ctx, bus);
      markPhase(doc, "verify", report.ok ? "ok" : "fail");
      await saveAndApply(ctx, doc, "after verify");
    }

    if (report && !report.ok && filter("fix") && !opts.skipCopilot) {
      markPhase(doc, "fix", "running");
      const final = await runFixLoop(ctx, bus, report, {
        maxIterations: opts.maxFixIterations,
      });
      markPhase(doc, "fix", final.ok ? "ok" : "fail");
      await saveAndApply(ctx, doc, "after fix");
      if (!final.ok) exitCode = 2;
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
  doc: Awaited<ReturnType<typeof loadMigrationDoc>>,
  note: string,
): Promise<void> {
  applyContextToDoc(doc, ctx);
  await saveMigrationDoc(ctx.planPath, doc, [
    {
      heading: "Status",
      body: `${note} at ${new Date().toISOString()}`,
    },
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
