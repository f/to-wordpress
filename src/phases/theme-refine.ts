import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MigrationContext } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import { runCopilotPhase } from "./theme.js";
import { wpCli } from "../wp/wpEnv.js";
import type { PrerenderResult } from "./prerender.js";

export interface ThemeGap {
  kind:
    | "missing-heading"
    | "wrong-heading"
    | "missing-nav-item"
    | "wrong-nav-text"
    | "missing-image"
    | "extra-image"
    | "class-drift"
    | "wrong-menu-count"
    | "wrong-footer-copy"
    | "empty-body"
    | "other";
  selector?: string;
  expected?: string;
  actual?: string;
  note?: string;
}

export interface ThemeGapReport {
  ok: boolean;
  wpUrl: string;
  issues: ThemeGap[];
  liveBytes: number;
  referenceBytes: number;
}

/**
 * Post-theme refinement loop. Activates the freshly generated theme on
 * wp-env, fetches `{{wpUrl}}/`, diffs it structurally against the
 * pre-rendered source home page, and — if gaps remain — invokes
 * Copilot with a focused `theme-refine` prompt to close them. Loops
 * up to {@link maxPasses} (default 3). No-op if prerender didn't
 * produce a reference home page.
 */
export async function runThemeRefine(
  ctx: MigrationContext,
  bus: UiBus,
  prerender: PrerenderResult,
  opts: { maxPasses?: number } = {},
): Promise<void> {
  const maxPasses = opts.maxPasses ?? 3;

  const home = prerender.samples.find((s) => s.kind === "home");
  if (!prerender.ok || !home || !existsSync(home.filePath)) {
    bus.pushStreamEvent("theme", {
      type: "info",
      phase: "theme",
      message: "theme refinement skipped — no rendered source home to diff against",
    });
    return;
  }

  if (!ctx.wpUrl) {
    bus.pushStreamEvent("theme", {
      type: "warn",
      phase: "theme",
      message: "theme refinement skipped — wp-env URL unknown",
    });
    return;
  }

  const detected = ctx.detected!;
  const themeSlug = detected.themeSlug;

  // Activate the theme so the live fetch actually renders it. Best
  // effort — if wp-env isn't ready we just log and bail.
  const activate = await wpCli(["theme", "activate", themeSlug], { cwd: ctx.sourceDir });
  if (activate.exitCode !== 0) {
    bus.pushStreamEvent("theme", {
      type: "warn",
      phase: "theme",
      message: `theme refinement skipped — could not activate theme ${themeSlug}: ${activate.stderr.trim().slice(0, 200)}`,
    });
    return;
  }

  const referenceHtml = await readFile(home.filePath, "utf8");

  for (let pass = 1; pass <= maxPasses; pass++) {
    bus.pushStreamEvent("theme", {
      type: "info",
      phase: "theme",
      message: `theme refinement pass ${pass}/${maxPasses} — fetching ${ctx.wpUrl}/`,
    });

    const liveHtml = await fetchLive(ctx.wpUrl);
    if (!liveHtml) {
      bus.pushStreamEvent("theme", {
        type: "warn",
        phase: "theme",
        message: `theme refinement aborted — could not fetch ${ctx.wpUrl}/`,
      });
      return;
    }

    const report = computeGapReport(liveHtml, referenceHtml, ctx.wpUrl);
    if (report.issues.length === 0) {
      bus.pushStreamEvent("theme", {
        type: "info",
        phase: "theme",
        message: `theme refinement: live home matches reference (pass ${pass})`,
      });
      return;
    }

    bus.pushStreamEvent("theme", {
      type: "info",
      phase: "theme",
      message: `theme refinement pass ${pass}: ${report.issues.length} gap${report.issues.length === 1 ? "" : "s"} — handing to Copilot`,
    });

    const tpl = await loadPrompt("theme-refine");
    const prompt = interpolate(tpl, {
      PASS: String(pass),
      MAX_PASSES: String(maxPasses),
      THEME_DIR: ctx.themeDir,
      THEME_SLUG: themeSlug,
      SOURCE_DIR: ctx.sourceDir,
      RENDERED_DIR: prerender.renderedDir ?? "",
      WP_URL: ctx.wpUrl,
      GAP_REPORT_JSON: JSON.stringify(report, null, 2),
      SOURCE_HOME_HTML: referenceHtml.slice(0, 8000),
      LIVE_HOME_HTML: liveHtml.slice(0, 8000),
    });

    const result = await runCopilotPhase(bus, "theme", {
      prompt,
      cwd: ctx.sourceDir,
      addDirs: [ctx.sourceDir, ctx.themeDir, prerender.renderedDir ?? ctx.workDir],
      resumeSessionId: ctx.copilotSessionId,
      maxAutopilotContinues: 80,
      timeoutMs: 20 * 60 * 1000,
    });
    if (result.sessionId) ctx.copilotSessionId = result.sessionId;
    if (result.exitCode !== 0) {
      bus.pushStreamEvent("theme", {
        type: "warn",
        phase: "theme",
        message: `theme refinement pass ${pass} copilot exit ${result.exitCode} — continuing with next pass`,
      });
    }
  }

  bus.pushStreamEvent("theme", {
    type: "warn",
    phase: "theme",
    message: `theme refinement exhausted ${maxPasses} passes — final verify/fix will pick up any remaining gaps`,
  });
}

async function fetchLive(wpUrl: string): Promise<string | null> {
  try {
    const res = await fetch(wpUrl, { headers: { "user-agent": "to-wordpress/theme-refine" } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Cheap structural gap report. Walks a handful of invariants we know
 * should match between source and WP — headings text, visible nav
 * items, image alts — and returns the differences. No full DOM diff;
 * Copilot is the one closing the gap, we just need a reasonably
 * complete checklist to hand it.
 */
export function computeGapReport(liveHtml: string, refHtml: string, wpUrl: string): ThemeGapReport {
  const issues: ThemeGap[] = [];

  const liveBody = stripScripts(extractBody(liveHtml));
  const refBody = stripScripts(extractBody(refHtml));

  if (liveBody.replace(/\s+/g, "").length < 200) {
    issues.push({
      kind: "empty-body",
      note: "live WP body is nearly empty — theme may not be rendering anything",
    });
  }

  const liveHeadings = extractHeadings(liveBody);
  const refHeadings = extractHeadings(refBody);
  diffTextList(refHeadings, liveHeadings, "missing-heading", "wrong-heading", issues, (h) => `h${h.level}`);

  const liveNav = extractNavLinks(liveBody);
  const refNav = extractNavLinks(refBody);
  if (Math.abs(liveNav.length - refNav.length) >= 2) {
    issues.push({
      kind: "wrong-menu-count",
      expected: String(refNav.length),
      actual: String(liveNav.length),
      note: "top-level nav link count drifted by 2+ items",
    });
  }
  diffTextList(refNav, liveNav, "missing-nav-item", "wrong-nav-text", issues, () => "nav a");

  const liveImgs = extractImages(liveBody);
  const refImgs = extractImages(refBody);
  const liveSrcs = new Set(liveImgs.map((i) => basenameOf(i.src)));
  for (const img of refImgs) {
    const base = basenameOf(img.src);
    if (!liveSrcs.has(base)) {
      issues.push({
        kind: "missing-image",
        selector: `img[alt="${img.alt.slice(0, 40)}"]`,
        expected: img.src,
        note: img.alt ? `alt: ${img.alt}` : undefined,
      });
    }
  }

  const refFooter = extractFooter(refBody);
  const liveFooter = extractFooter(liveBody);
  if (refFooter && liveFooter && refFooter !== liveFooter) {
    issues.push({
      kind: "wrong-footer-copy",
      expected: refFooter.slice(0, 120),
      actual: liveFooter.slice(0, 120),
    });
  }

  return {
    ok: issues.length === 0,
    wpUrl,
    issues: issues.slice(0, 40),
    liveBytes: liveHtml.length,
    referenceBytes: refHtml.length,
  };
}

function extractBody(html: string): string {
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return m ? m[1] : html;
}

function stripScripts(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractHeadings(html: string): Array<{ level: number; text: string }> {
  const out: Array<{ level: number; text: string }> = [];
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = stripTags(m[2]);
    if (text) out.push({ level: Number(m[1]), text });
  }
  return out;
}

function extractNavLinks(html: string): Array<{ level: number; text: string }> {
  const out: Array<{ level: number; text: string }> = [];
  // Prefer the first <nav> or <header><nav>; fall back to all top-level
  // <ul> groups that contain at least 3 <a> tags.
  const navMatch = /<(?:header|nav)[^>]*>([\s\S]*?)<\/(?:header|nav)>/i.exec(html);
  const region = navMatch ? navMatch[1] : html;
  const linkRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(region)) !== null) {
    const text = stripTags(m[1]);
    if (text && text.length < 80) out.push({ level: 0, text });
  }
  return out;
}

function extractImages(html: string): Array<{ src: string; alt: string }> {
  const out: Array<{ src: string; alt: string }> = [];
  const re = /<img\b[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const src = m[1];
    const altMatch = /\salt\s*=\s*["']([^"']*)["']/i.exec(m[0]);
    out.push({ src, alt: altMatch ? altMatch[1] : "" });
  }
  return out;
}

function extractFooter(html: string): string | undefined {
  const m = /<footer[^>]*>([\s\S]*?)<\/footer>/i.exec(html);
  if (!m) return undefined;
  return stripTags(m[1]).slice(0, 240);
}

function basenameOf(url: string): string {
  const q = url.indexOf("?");
  const clean = q >= 0 ? url.slice(0, q) : url;
  const parts = clean.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? clean;
}

/**
 * Diff two text lists. For each reference text, find the closest live
 * match by normalized equality; if none, record the appropriate gap.
 */
function diffTextList(
  ref: Array<{ level: number; text: string }>,
  live: Array<{ level: number; text: string }>,
  missingKind: ThemeGap["kind"],
  wrongKind: ThemeGap["kind"],
  issues: ThemeGap[],
  selector: (r: { level: number; text: string }) => string,
): void {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const liveSet = new Set(live.map((l) => norm(l.text)));
  const liveByPrefix = new Map<string, string>();
  for (const l of live) {
    const k = norm(l.text).slice(0, 16);
    if (!liveByPrefix.has(k)) liveByPrefix.set(k, l.text);
  }
  for (const r of ref) {
    const key = norm(r.text);
    if (liveSet.has(key)) continue;
    const prefixHit = liveByPrefix.get(key.slice(0, 16));
    if (prefixHit && prefixHit !== r.text) {
      issues.push({ kind: wrongKind, selector: selector(r), expected: r.text, actual: prefixHit });
    } else {
      issues.push({ kind: missingKind, selector: selector(r), expected: r.text });
    }
  }
}

export const __testables = { computeGapReport };
