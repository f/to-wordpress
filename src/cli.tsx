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
import {
  applyContextToDoc,
  loadMigrationDoc,
  markPhase,
  saveMigrationDoc,
  type MigrationDoc,
} from "./state/migration.js";
import { runFresh } from "./phases/fresh.js";
import { setupGit } from "./phases/git.js";
import { computeEta } from "./phases/eta.js";
import {
  DEFAULT_AGENT,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_COPILOT_EFFORT,
  DEFAULT_COPILOT_MODEL,
  type AgentKind,
} from "./agents/index.js";
import { runAgenticLoop, type FailStrategy } from "./phases/loop.js";
import {
  detectLoop,
  planLoop,
  bootLoop,
  themeLoop,
  pluginLoop,
  normalizeLoop,
  blockifyLoop,
  importLoop,
  verifyLoop,
  testfixLoop,
} from "./phases/loops.js";
import type { PhaseStatus } from "./types.js";

const PACKAGE_VERSION = "0.5.0";

interface CliOptions {
  agent?: AgentKind;
  skipBoot?: boolean;
  skipCopilot?: boolean;
  only?: string;
  from?: PhaseId;
  until?: PhaseId;
  maxAttempts?: number;
  maxFixPasses?: number;
  failStrategy?: FailStrategy;
  yes?: boolean;
  fresh?: boolean;
  branch?: string;
  git?: boolean;
  permalinks?: "keep" | "default";
  cpts?: "all" | "none";
  redirects?: boolean;
  frontPage?: string;
  blogIndex?: string;
  privacyPage?: string;
  adminUser?: string;
  adminPassword?: string;
  adminEmail?: string;
}

const PHASE_ORDER: PhaseId[] = [
  "detect",
  "plan",
  "boot",
  "theme",
  "normalize",
  "blockify",
  "plugin",
  "import",
  "verify",
  "testfix",
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
    .option("--agent <kind>", "which AI agent CLI to use: claude|copilot|codex (env: TOWP_AGENT)", DEFAULT_AGENT)
    .option("--skip-boot", "skip wp-env start (assumes already running)")
    .option("--skip-copilot", "use deterministic fallbacks only, don't invoke the AI agent")
    .option("-y, --yes", "headless mode (no TUI, log to stdout)")
    .option("--only <phase>", "run only this phase (skips all others)")
    .option("--from <phase>", "start from this phase (skip earlier ones)")
    .option("--until <phase>", "stop after this phase (skip later ones)")
    .option("--max-attempts <n>", "max crash-retry attempts per phase", (v) => Number(v), 3)
    .option("--max-fix-passes <n>", "max test-fail-fix iterations per phase", (v) => Number(v), 3)
    .option("--fail-strategy <strategy>", "what to do when a phase exhausts retries: abort|skip|continue", "continue")
    .option("--permalinks <mode>", "permalink mapping: keep (mirror source URLs) or default (/%postname%/)", "keep")
    .option("--cpts <mode>", "custom post types: all (create CPT per collection) or none (import as posts)", "all")
    .option("--no-redirects", "skip generating redirects.json for changed URL shapes")
    .option("--front-page <slug>", "slug of the page to use as static front page (auto-detected if omitted)")
    .option("--blog-index <slug>", "slug of the page to use as blog index (auto-detected if omitted)")
    .option("--privacy-page <slug>", "slug of the privacy policy page (auto-detected if omitted)")
    .option("--admin-user <name>", "WordPress admin username", "admin")
    .option("--admin-password <pass>", "WordPress admin password", "password")
    .option("--admin-email <email>", "WordPress admin email", "admin@example.com")
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
    planOverrides: {
      permalinks: opts.permalinks as "keep" | "default" | undefined,
      cpts: opts.cpts as "all" | "none" | undefined,
      redirects: opts.redirects,
      frontPage: opts.frontPage,
      blogIndex: opts.blogIndex,
      privacyPage: opts.privacyPage,
      adminUser: opts.adminUser,
      adminPassword: opts.adminPassword,
      adminEmail: opts.adminEmail,
    },
  };

  await mkdir(workDir, { recursive: true });
  await mkdir(ctx.themeDir, { recursive: true });
  await mkdir(ctx.pluginDir, { recursive: true });

  const bus = new UiBus();
  const startedAt = Date.now();

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
  const failStrategy = (opts.failStrategy ?? "continue") as FailStrategy;

  // Propagate agent selection via env so every phase invocation sees it
  // (resolveAgent in src/agents/index.ts reads TOWP_AGENT on every call).
  const requested = opts.agent ?? DEFAULT_AGENT;
  const agentKind: AgentKind =
    requested === "copilot" || requested === "codex" ? requested : "claude";
  process.env.TOWP_AGENT = agentKind;

  if (!opts.skipCopilot) {
    const model =
      agentKind === "claude"
        ? DEFAULT_CLAUDE_MODEL
        : agentKind === "codex"
          ? (DEFAULT_CODEX_MODEL || "(codex default)")
          : DEFAULT_COPILOT_MODEL;
    const extras =
      agentKind === "claude"
        ? "(override with --model / CLAUDE_MODEL)"
        : agentKind === "codex"
          ? "(override with --model / CODEX_MODEL)"
          : `effort: ${DEFAULT_COPILOT_EFFORT} (override with --model / COPILOT_MODEL, --effort / COPILOT_EFFORT)`;
    bus.pushStreamEvent(undefined, {
      type: "info",
      phase: "detect",
      message: `Agent: ${agentKind} · model: ${model} · ${extras}`,
    });
  }

  const loopOpts = {
    maxAttempts: opts.maxAttempts ?? 3,
    maxFixPasses: opts.maxFixPasses ?? 3,
    failStrategy,
    gitEnabled,
    skipCopilot: Boolean(opts.skipCopilot),
  };

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
    for (const id of Object.keys(doc.phases) as PhaseId[]) {
      if (doc.phases[id].status === "running") {
        doc.phases[id].status = "pending";
        doc.phases[id].notes = "recovered from interrupted run";
      }
    }
    await hydrateWpUrl(ctx);

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
      loop: import("./phases/loop.js").PhaseLoop<T>,
    ): Promise<T | undefined> => {
      if (!filter(loop.phase)) return undefined;
      if (resumeMode && doc.phases[loop.phase]?.status === "ok") {
        bus.pushStreamEvent(undefined, {
          type: "info",
          phase: loop.phase,
          message: `${PHASE_TITLES[loop.phase]}: already complete, skipping (resume)`,
        });
        return undefined;
      }
      return runAgenticLoop(ctx, bus, doc, loop, loopOpts);
    };

    await step(detectLoop(ctx, bus));
    await step(planLoop(ctx, bus));
    await step(bootLoop(ctx, bus, Boolean(opts.skipBoot)));
    await step(themeLoop(ctx, bus, Boolean(opts.skipCopilot)));
    await step(normalizeLoop(ctx, bus));
    await step(blockifyLoop(ctx, bus, Boolean(opts.skipCopilot)));
    await step(pluginLoop(ctx, bus, Boolean(opts.skipCopilot)));
    await step(importLoop(ctx, bus));
    await step(verifyLoop(ctx, bus));
    await step(testfixLoop(ctx, bus, Boolean(opts.skipBoot)));

    // Check if any phase ended in fail
    for (const id of PHASE_ORDER) {
      if (doc.phases[id]?.status === "fail") {
        exitCode = 2;
        break;
      }
    }
  } catch (err) {
    bus.pushStreamEvent(undefined, { type: "error", message: (err as Error).message });
    exitCode = 1;
  }

  if (exitCode === 0) {
    await hydrateWpUrl(ctx);
    const siteUrl = ctx.wpUrl ?? "http://localhost:8888";
    const adminUrl = siteUrl.replace(/\/+$/, "") + "/wp-admin/";
    const adminUser = ctx.choices?.adminUser ?? "admin";
    const adminPassword = ctx.choices?.adminPassword ?? "password";
    const durationSeconds = Math.round((Date.now() - startedAt) / 1000);

    for (const line of [
      "────────────────────────────────────────────────────",
      "  Migration complete — your WordPress is ready.",
      "────────────────────────────────────────────────────",
      `  Site:      ${siteUrl}`,
      `  Admin:     ${adminUrl}`,
      `  Username:  ${adminUser}`,
      `  Password:  ${adminPassword}`,
      `  Source:    ${ctx.sourceDir}`,
      "────────────────────────────────────────────────────",
      "  Tip: `npx wp-env stop` pauses the stack; `npx wp-env start` resumes.",
    ]) {
      bus.pushStreamEvent(undefined, { type: "info", phase: "verify", message: line });
    }

    bus.emit("summary", {
      siteUrl,
      adminUrl,
      adminUser,
      adminPassword,
      sourceDir: ctx.sourceDir,
      durationSeconds,
    });
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
