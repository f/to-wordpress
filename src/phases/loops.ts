/**
 * PhaseLoop definitions for every phase. Each function returns a
 * PhaseLoop<T> that the AgenticLoop runner uses to attempt/test/fix
 * the phase autonomously.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MigrationContext } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import type { PhaseLoop } from "./loop.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import { runDetect } from "./detect.js";
import { runPlan } from "./plan.js";
import { runBoot } from "./boot.js";
import { runTheme } from "./theme.js";
import { runPlugin } from "./plugin.js";
import { runNormalize } from "./normalize.js";
import { runImport } from "./import.js";
import { runVerify, type VerifyReport } from "./verify.js";
import { wpCli } from "../wp/wpEnv.js";

// ─── Simple report types for phases that don't have rich reports ──────

interface SimpleReport {
  ok: boolean;
  issues: string[];
}

// ─── detect ───────────────────────────────────────────────────────────

export function detectLoop(ctx: MigrationContext, bus: UiBus): PhaseLoop<SimpleReport> {
  return {
    phase: "detect",
    async attempt() {
      ctx.detected = await runDetect(ctx, bus);
    },
    async test() {
      const issues: string[] = [];
      if (!ctx.detected) {
        issues.push("detection produced no result");
      } else {
        if (ctx.detected.kind === "unknown") issues.push("kind is unknown");
        if (ctx.detected.collections.length === 0 && ctx.detected.pages.length === 0) {
          issues.push("no collections or pages found");
        }
      }
      return { ok: issues.length === 0, issues };
    },
    isOk: (r) => r.ok,
    describeIssues: (r) => r.issues.join("; "),
    async buildFixPrompt() {
      return undefined;
    },
  };
}

// ─── plan ─────────────────────────────────────────────────────────────

export function planLoop(ctx: MigrationContext, bus: UiBus): PhaseLoop<SimpleReport> {
  return {
    phase: "plan",
    async attempt() {
      ctx.choices = await runPlan(ctx, bus);
    },
    async test() {
      const issues: string[] = [];
      if (!ctx.choices) {
        issues.push("plan produced no choices");
      } else {
        if (!ctx.choices.adminUser) issues.push("adminUser missing");
        if (!ctx.choices.adminEmail) issues.push("adminEmail missing");
      }
      return { ok: issues.length === 0, issues };
    },
    isOk: (r) => r.ok,
    describeIssues: (r) => r.issues.join("; "),
    async buildFixPrompt() {
      return undefined;
    },
  };
}

// ─── boot ─────────────────────────────────────────────────────────────

export function bootLoop(
  ctx: MigrationContext,
  bus: UiBus,
  skip: boolean,
): PhaseLoop<SimpleReport> {
  return {
    phase: "boot",
    skip,
    async attempt() {
      await runBoot(ctx, bus);
    },
    async test() {
      const issues: string[] = [];
      if (!ctx.wpUrl) {
        issues.push("wpUrl not set after boot");
        return { ok: false, issues };
      }
      try {
        const res = await fetch(ctx.wpUrl, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) issues.push(`GET / returned ${res.status}`);
        const body = await res.text();
        if (/(fatal error|there has been a critical error)/i.test(body)) {
          issues.push("fatal error marker in response body");
        }
      } catch (err) {
        issues.push(`GET / failed: ${(err as Error).message}`);
      }
      return { ok: issues.length === 0, issues };
    },
    isOk: (r) => r.ok,
    describeIssues: (r) => r.issues.join("; "),
    async buildFixPrompt() {
      return undefined;
    },
  };
}

// ─── theme ────────────────────────────────────────────────────────────

const REQUIRED_BLOCK_THEME_FILES = [
  "style.css",
  "functions.php",
  "theme.json",
  "templates/index.html",
  "parts/header.html",
  "parts/footer.html",
];

export function themeLoop(
  ctx: MigrationContext,
  bus: UiBus,
  skip: boolean,
): PhaseLoop<SimpleReport> {
  return {
    phase: "theme",
    skip,
    async attempt() {
      await runTheme(ctx, bus);
    },
    async test() {
      const issues: string[] = [];
      const missing = REQUIRED_BLOCK_THEME_FILES.filter(
        (f) => !existsSync(join(ctx.themeDir, f)),
      );
      if (missing.length > 0) {
        issues.push(`missing templates: ${missing.join(", ")}`);
      }
      if (ctx.wpUrl) {
        try {
          const res = await fetch(ctx.wpUrl, { signal: AbortSignal.timeout(15000) });
          if (!res.ok) issues.push(`GET / returned ${res.status}`);
          const body = await res.text();
          if (/(fatal error|there has been a critical error)/i.test(body)) {
            issues.push("fatal error marker in rendered page");
          }
        } catch {
          // wp-env may not be up yet during theme phase; non-fatal
        }
      }
      return { ok: issues.length === 0, issues };
    },
    isOk: (r) => r.ok,
    describeIssues: (r) => r.issues.join("; "),
    async buildFixPrompt(report, pass) {
      const tpl = await loadPrompt("fix");
      return interpolate(tpl, {
        VERIFY_REPORT_JSON: JSON.stringify(report, null, 2),
        THEME_DIR: ctx.themeDir,
        PLUGIN_DIR: ctx.pluginDir,
        CONTENT_DIR: ctx.contentDir,
        SOURCE_DIR: ctx.sourceDir,
        WP_URL: ctx.wpUrl ?? "",
      });
    },
    copilotFixOpts: () => ({
      addDirs: [ctx.sourceDir, ctx.workDir, ctx.themeDir, ctx.pluginDir],
      maxAutopilotContinues: 80,
      timeoutMs: 20 * 60 * 1000,
    }),
  };
}

// ─── plugin ───────────────────────────────────────────────────────────

export function pluginLoop(
  ctx: MigrationContext,
  bus: UiBus,
  skip: boolean,
): PhaseLoop<SimpleReport> {
  return {
    phase: "plugin",
    skip,
    async attempt() {
      await runPlugin(ctx, bus);
    },
    async test() {
      const issues: string[] = [];
      const detected = ctx.detected;
      if (!detected) return { ok: false, issues: ["no detected context"] };

      const mainFile = join(ctx.pluginDir, `${detected.pluginSlug}.php`);
      if (!existsSync(mainFile)) {
        issues.push(`main plugin file missing: ${detected.pluginSlug}.php`);
      }

      if (ctx.wpUrl) {
        try {
          const result = await wpCli(["eval", "echo 1;"], { cwd: ctx.sourceDir });
          if (result.exitCode !== 0) {
            issues.push(`wp eval failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`);
          }
        } catch (err) {
          issues.push(`wp eval threw: ${(err as Error).message}`);
        }
      }
      return { ok: issues.length === 0, issues };
    },
    isOk: (r) => r.ok,
    describeIssues: (r) => r.issues.join("; "),
    async buildFixPrompt(report) {
      const tpl = await loadPrompt("fix");
      return interpolate(tpl, {
        VERIFY_REPORT_JSON: JSON.stringify(report, null, 2),
        THEME_DIR: ctx.themeDir,
        PLUGIN_DIR: ctx.pluginDir,
        CONTENT_DIR: ctx.contentDir,
        SOURCE_DIR: ctx.sourceDir,
        WP_URL: ctx.wpUrl ?? "",
      });
    },
  };
}

// ─── normalize ────────────────────────────────────────────────────────

export function normalizeLoop(ctx: MigrationContext, bus: UiBus): PhaseLoop<SimpleReport> {
  return {
    phase: "normalize",
    async attempt() {
      await runNormalize(ctx, bus);
    },
    async test() {
      const issues: string[] = [];
      const indexPath = join(ctx.contentDir, "index.json");
      if (!existsSync(indexPath)) {
        issues.push("index.json not created");
        return { ok: false, issues };
      }

      try {
        const idx = JSON.parse(await readFile(indexPath, "utf8")) as {
          items: Array<{ path: string }>;
          failures?: Array<{ sourcePath: string }>;
        };
        if (!idx.items || idx.items.length === 0) {
          issues.push("index.json has no items");
        }
        for (const item of (idx.items ?? []).slice(0, 50)) {
          if (!existsSync(item.path)) {
            issues.push(`referenced file missing: ${item.path}`);
          }
        }
        if (idx.failures && idx.failures.length > 0) {
          issues.push(`${idx.failures.length} normalization failure(s) recorded`);
        }
      } catch (err) {
        issues.push(`index.json parse error: ${(err as Error).message}`);
      }

      return { ok: issues.length === 0, issues };
    },
    isOk: (r) => r.ok,
    describeIssues: (r) => r.issues.join("; "),
    async buildFixPrompt() {
      return undefined;
    },
  };
}

// ─── import ───────────────────────────────────────────────────────────

export function importLoop(ctx: MigrationContext, bus: UiBus): PhaseLoop<SimpleReport> {
  return {
    phase: "import",
    async attempt() {
      await runImport(ctx, bus);
    },
    async test() {
      const issues: string[] = [];
      if (!ctx.wpUrl) return { ok: false, issues: ["wpUrl not set"] };

      const indexPath = join(ctx.contentDir, "index.json");
      if (!existsSync(indexPath)) return { ok: true, issues: [] };

      try {
        const idx = JSON.parse(await readFile(indexPath, "utf8")) as {
          items: Array<{ postType: string; slug: string }>;
        };

        const expectedPosts = idx.items.filter((i) => i.postType === "post").length;
        const expectedPages = idx.items.filter((i) => i.postType === "page").length;

        if (expectedPosts > 0) {
          const res = await wpCli(
            ["post", "list", "--post_type=post", "--post_status=publish", "--format=count"],
            { cwd: ctx.sourceDir },
          );
          const actual = Number(res.stdout.trim()) || 0;
          if (actual < expectedPosts * 0.8) {
            issues.push(`posts: expected ~${expectedPosts}, found ${actual}`);
          }
        }

        if (expectedPages > 0) {
          const res = await wpCli(
            ["post", "list", "--post_type=page", "--post_status=publish", "--format=count"],
            { cwd: ctx.sourceDir },
          );
          const actual = Number(res.stdout.trim()) || 0;
          if (actual < expectedPages * 0.8) {
            issues.push(`pages: expected ~${expectedPages}, found ${actual}`);
          }
        }
      } catch (err) {
        issues.push(`import test error: ${(err as Error).message}`);
      }

      return { ok: issues.length === 0, issues };
    },
    isOk: (r) => r.ok,
    describeIssues: (r) => r.issues.join("; "),
    async buildFixPrompt(report) {
      const tpl = await loadPrompt("fix");
      return interpolate(tpl, {
        VERIFY_REPORT_JSON: JSON.stringify(report, null, 2),
        THEME_DIR: ctx.themeDir,
        PLUGIN_DIR: ctx.pluginDir,
        CONTENT_DIR: ctx.contentDir,
        SOURCE_DIR: ctx.sourceDir,
        WP_URL: ctx.wpUrl ?? "",
      });
    },
  };
}

// ─── verify ───────────────────────────────────────────────────────────

export function verifyLoop(ctx: MigrationContext, bus: UiBus): PhaseLoop<VerifyReport> {
  return {
    phase: "verify",
    async attempt() {
      // Verify is itself the test — attempt is a no-op, the test() does the real work
    },
    async test() {
      return runVerify(ctx, bus);
    },
    isOk: (r) => r.ok,
    describeIssues: (r) =>
      r.issues.map((i) => `${i.kind}: ${i.message}`).join("; "),
    async buildFixPrompt(report) {
      const tpl = await loadPrompt("fix");
      return interpolate(tpl, {
        VERIFY_REPORT_JSON: JSON.stringify(report, null, 2),
        THEME_DIR: ctx.themeDir,
        PLUGIN_DIR: ctx.pluginDir,
        CONTENT_DIR: ctx.contentDir,
        SOURCE_DIR: ctx.sourceDir,
        WP_URL: ctx.wpUrl ?? "",
      });
    },
    copilotFixOpts: () => ({
      addDirs: [ctx.sourceDir, ctx.workDir, ctx.themeDir, ctx.pluginDir],
      maxAutopilotContinues: 60,
      timeoutMs: 15 * 60 * 1000,
    }),
  };
}

// ─── testfix (endpoint sweep) ─────────────────────────────────────────

interface EndpointTestReport {
  wpUrl: string;
  checked: number;
  ok: boolean;
  issues: Array<{
    path: string;
    status?: number;
    kind: string;
    message: string;
  }>;
}

export function testfixLoop(
  ctx: MigrationContext,
  bus: UiBus,
  skip: boolean,
): PhaseLoop<EndpointTestReport> {
  return {
    phase: "testfix",
    skip,
    async attempt() {
      // The endpoint sweep IS the test; attempt is a no-op
    },
    async test() {
      // Import runEndpointSweep dynamically to avoid circular deps
      const { runEndpointSweep } = await import("./testfix.js");
      return runEndpointSweep(ctx, bus);
    },
    isOk: (r) => r.ok,
    describeIssues: (r) =>
      r.issues.map((i) => `${i.kind}: ${i.message}`).join("; "),
    async buildFixPrompt(report, pass) {
      const tpl = await loadPrompt("test-fix");
      return interpolate(tpl, {
        TEST_REPORT_JSON: JSON.stringify(report, null, 2),
        PASS: String(pass),
        MAX_PASSES: "3",
        WP_URL: ctx.wpUrl ?? "",
        SOURCE_DIR: ctx.sourceDir,
        THEME_DIR: ctx.themeDir,
        PLUGIN_DIR: ctx.pluginDir,
        CONTENT_DIR: ctx.contentDir,
      });
    },
    copilotFixOpts: () => ({
      addDirs: [ctx.sourceDir, ctx.workDir, ctx.themeDir, ctx.pluginDir, ctx.contentDir],
      maxAutopilotContinues: 60,
      timeoutMs: 15 * 60 * 1000,
    }),
  };
}
