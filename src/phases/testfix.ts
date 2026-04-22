import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MigrationContext } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import { runCopilotPhase } from "./theme.js";

export interface EndpointIssue {
  path: string;
  status?: number;
  kind: "http_404" | "http_500" | "timeout" | "network" | "fatal_html";
  message: string;
}

export interface EndpointTestReport {
  wpUrl: string;
  checked: number;
  ok: boolean;
  issues: EndpointIssue[];
}

export interface TestFixOptions {
  maxIterations?: number;
  allowCopilot?: boolean;
}

export async function runTestFixLoop(
  ctx: MigrationContext,
  bus: UiBus,
  opts: TestFixOptions = {},
): Promise<EndpointTestReport> {
  if (!ctx.wpUrl) throw new Error("boot phase must run before testfix");
  const maxIter = opts.maxIterations ?? 3;
  const allowCopilot = opts.allowCopilot !== false;

  let report = await runEndpointSweep(ctx, bus);
  let iter = 0;

  while (!report.ok && allowCopilot && iter < maxIter) {
    iter++;
    bus.pushStreamEvent("testfix", {
      type: "phase_start",
      phase: "testfix",
      message: `road-testing routes — pass ${iter}/${maxIter}, ${report.issues.length} endpoint issue${report.issues.length === 1 ? "" : "s"}`,
    });

    const tpl = await loadPrompt("test-fix");
    const prompt = interpolate(tpl, {
      TEST_REPORT_JSON: JSON.stringify(report, null, 2),
      PASS: String(iter),
      MAX_PASSES: String(maxIter),
      WP_URL: ctx.wpUrl,
      SOURCE_DIR: ctx.sourceDir,
      THEME_DIR: ctx.themeDir,
      PLUGIN_DIR: ctx.pluginDir,
      CONTENT_DIR: ctx.contentDir,
    });

    const result = await runCopilotPhase(bus, "testfix", {
      prompt,
      cwd: ctx.sourceDir,
      addDirs: [ctx.sourceDir, ctx.workDir, ctx.themeDir, ctx.pluginDir, ctx.contentDir],
      resumeSessionId: ctx.copilotSessionId,
      maxAutopilotContinues: 60,
      timeoutMs: 15 * 60 * 1000,
    });
    if (result.sessionId) ctx.copilotSessionId = result.sessionId;
    bus.pushStreamEvent("testfix", { type: "info", phase: "testfix", message: "re-running endpoint sweep" });
    report = await runEndpointSweep(ctx, bus);
  }

  if (report.ok) {
    bus.pushStreamEvent("testfix", {
      type: "phase_ok",
      phase: "testfix",
      message: "all sampled endpoints return healthy responses",
    });
  } else if (!allowCopilot) {
    bus.pushStreamEvent("testfix", {
      type: "phase_fail",
      phase: "testfix",
      message: `${report.issues.length} endpoint issue${report.issues.length === 1 ? "" : "s"} found (copilot disabled)`,
    });
  } else {
    bus.pushStreamEvent("testfix", {
      type: "phase_fail",
      phase: "testfix",
      message: `${report.issues.length} endpoint issue${report.issues.length === 1 ? "" : "s"} remain after ${iter} pass${iter === 1 ? "" : "es"}`,
    });
  }

  return report;
}

async function runEndpointSweep(ctx: MigrationContext, bus: UiBus): Promise<EndpointTestReport> {
  const endpoints = await gatherEndpoints(ctx);
  const issues: EndpointIssue[] = [];
  const wpUrl = ctx.wpUrl!;

  bus.pushStreamEvent("testfix", {
    type: "info",
    phase: "testfix",
    message: `testing ${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}`,
  });

  for (const p of endpoints) {
    const url = new URL(p, wpUrl).toString();
    const res = await fetchWithTimeout(url, 12000);
    if (!res) {
      issues.push({ path: p, kind: "network", message: `request failed for ${url}` });
      continue;
    }
    if (res.timeout) {
      issues.push({ path: p, kind: "timeout", message: `timeout for ${url}` });
      continue;
    }
    if (res.status === 404) {
      issues.push({ path: p, status: 404, kind: "http_404", message: `404 for ${url}` });
      continue;
    }
    if (res.status >= 500) {
      issues.push({ path: p, status: res.status, kind: "http_500", message: `${res.status} for ${url}` });
      continue;
    }
    if (/(fatal error|uncaught|wp_die|there has been a critical error)/i.test(res.body)) {
      issues.push({ path: p, status: res.status, kind: "fatal_html", message: `fatal error marker in HTML for ${url}` });
    }
  }

  const report: EndpointTestReport = {
    wpUrl,
    checked: endpoints.length,
    ok: issues.length === 0,
    issues,
  };
  await writeFile(join(ctx.workDir, "test-fix-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  return report;
}

async function gatherEndpoints(ctx: MigrationContext): Promise<string[]> {
  const out = new Set<string>(["/"]);
  if (ctx.choices?.blogIndexPageSlug) out.add(`/${ctx.choices.blogIndexPageSlug.replace(/^\/+|\/+$/g, "")}/`);
  if (ctx.choices?.frontPageSlug) out.add(`/${ctx.choices.frontPageSlug.replace(/^\/+|\/+$/g, "")}/`);

  const indexPath = join(ctx.contentDir, "index.json");
  if (existsSync(indexPath)) {
    try {
      const idx = JSON.parse(await readFile(indexPath, "utf8")) as {
        items?: Array<{ originalPermalink?: string }>;
      };
      for (const item of idx.items ?? []) {
        if (!item.originalPermalink) continue;
        out.add(item.originalPermalink);
      }
    } catch {
      // ignore malformed index; test what we already have
    }
  }
  return Array.from(out).slice(0, 60);
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; body: string; timeout?: boolean } | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
    const body = await res.text();
    return { status: res.status, body };
  } catch (err) {
    if ((err as Error).name === "AbortError") return { status: 0, body: "", timeout: true };
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

