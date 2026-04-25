import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { MigrationContext } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import { wpCli } from "../wp/wpEnv.js";

export interface VerifyIssue {
  kind: "missing_post" | "http_error" | "title_mismatch" | "count_mismatch" | "fatal_html" | "other";
  path?: string;
  expected?: string;
  actual?: string;
  message: string;
}

const ERROR_TEXT_RE =
  /(fatal error|uncaught|wp_die|there has been a critical error|parse error|call to undefined function|failed to open stream|warning:\s|notice:\s|deprecated:\s|undefined (?:variable|array key|index))/i;

export interface VerifyReport {
  wpUrl: string;
  ok: boolean;
  checked: number;
  issues: VerifyIssue[];
  countsBySource: Record<string, number>;
  countsByWp: Record<string, number>;
}

export async function runVerify(ctx: MigrationContext, bus: UiBus): Promise<VerifyReport> {
  bus.pushStreamEvent("verify", { type: "phase_start", phase: "verify", message: "reading it aloud — proofing the bound volume against the original" });
  const detected = ctx.detected;
  if (!detected) throw new Error("detect phase must run before verify");
  if (!ctx.wpUrl) throw new Error("boot phase must run before verify");

  const indexPath = join(ctx.contentDir, "index.json");
  const idx = existsSync(indexPath)
    ? (JSON.parse(await readFile(indexPath, "utf8")) as {
        items: Array<{ slug: string; path: string; originalPermalink: string; postType: string }>;
      })
    : { items: [] };

  const issues: VerifyIssue[] = [];

  const countsBySource: Record<string, number> = {};
  for (const coll of detected.collections) {
    countsBySource[coll.name === "posts" ? "post" : singular(coll.name)] = coll.count;
  }
  countsBySource.page = detected.pages.length;

  const countsByWp: Record<string, number> = {};
  for (const pt of Object.keys(countsBySource)) {
    const res = await wpCli(
      ["post", "list", `--post_type=${pt}`, "--post_status=publish", "--format=count"],
      { cwd: ctx.sourceDir },
    );
    const n = Number(res.stdout.trim()) || 0;
    countsByWp[pt] = n;
    if (n < countsBySource[pt]) {
      issues.push({
        kind: "count_mismatch",
        message: `post_type '${pt}': expected ${countsBySource[pt]}, got ${n}`,
      });
    }
  }

  const sample = idx.items.slice(0, Math.min(20, idx.items.length));
  const samplePaths = sample.map((item) => item.originalPermalink);
  for (const extraPath of await importantSitePaths(ctx)) {
    if (!samplePaths.includes(extraPath)) samplePaths.push(extraPath);
  }

  for (const path of samplePaths.slice(0, 60)) {
    const url = new URL(path, ctx.wpUrl).toString();
    const res = await fetchSafe(url);
    if (!res) {
      issues.push({ kind: "http_error", path, message: `fetch failed for ${url}` });
      continue;
    }
    if (res.status >= 400) {
      issues.push({
        kind: "http_error",
        path,
        message: `status ${res.status} for ${url}`,
      });
      continue;
    }
    const marker = ERROR_TEXT_RE.exec(res.body);
    if (marker) {
      issues.push({
        kind: "fatal_html",
        path,
        actual: marker[0],
        message: `error marker '${marker[0]}' in HTML for ${url}`,
      });
    }
    const title = extractTitle(res.body);
    const item = sample.find((it) => it.originalPermalink === path);
    const srcParsed = item ? await getFrontmatterTitle(item.path) : undefined;
    if (srcParsed && title && !titlesMatch(title, srcParsed)) {
      issues.push({
        kind: "title_mismatch",
        path,
        expected: srcParsed,
        actual: title,
        message: `title mismatch at ${path}`,
      });
    }
  }

  const report: VerifyReport = {
    wpUrl: ctx.wpUrl,
    ok: issues.length === 0,
    checked: samplePaths.length,
    issues,
    countsBySource,
    countsByWp,
  };

  const reportPath = join(ctx.workDir, "verify-report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  bus.pushStreamEvent("verify", {
    type: "info",
    phase: "verify",
    message: `checked ${samplePaths.length} urls; ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
  });
  bus.pushStreamEvent("verify", {
    type: report.ok ? "phase_ok" : "phase_fail",
    phase: "verify",
    message: report.ok ? "clean" : `${issues.length} issues — will attempt fix`,
  });
  return report;
}

async function fetchSafe(url: string): Promise<{ status: number; body: string } | undefined> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    const body = await res.text();
    return { status: res.status, body };
  } catch {
    return undefined;
  }
}

async function importantSitePaths(ctx: MigrationContext): Promise<string[]> {
  const out = new Set<string>(["/"]);
  if (ctx.choices?.blogIndexPageSlug) out.add(`/${ctx.choices.blogIndexPageSlug.replace(/^\/+|\/+$/g, "")}/`);
  if (ctx.choices?.frontPageSlug) out.add(`/${ctx.choices.frontPageSlug.replace(/^\/+|\/+$/g, "")}/`);
  for (const p of await sourceMenuPaths(ctx)) out.add(p);
  for (const p of await homePageInternalLinks(ctx)) out.add(p);
  return Array.from(out);
}

async function sourceMenuPaths(ctx: MigrationContext): Promise<string[]> {
  const candidates = [
    join(ctx.sourceDir, "_data", "menu.yml"),
    join(ctx.sourceDir, "_data", "menu.yaml"),
    join(ctx.sourceDir, "_data", "menu.json"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const raw = await readFile(file, "utf8");
      const parsed = file.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
      return extractMenuUrls(parsed).filter((u) => u.startsWith("/")).map(normalizePath);
    } catch {
      return [];
    }
  }
  return [];
}

function extractMenuUrls(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (!v) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (typeof obj.url === "string") out.push(obj.url);
      if (typeof obj.href === "string") out.push(obj.href);
      if (typeof obj.link === "string") out.push(obj.link);
      for (const x of Object.values(obj)) walk(x);
    }
  };
  walk(value);
  return Array.from(new Set(out));
}

async function homePageInternalLinks(ctx: MigrationContext): Promise<string[]> {
  try {
    const res = await fetchSafe(ctx.wpUrl!);
    if (!res?.body) return [];
    return extractInternalLinks(res.body, ctx.wpUrl!);
  } catch {
    return [];
  }
}

function extractInternalLinks(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href || href.startsWith("#") || /^(mailto|tel|sms|javascript):/i.test(href)) continue;
    try {
      const u = new URL(href, baseUrl);
      if (u.origin === new URL(baseUrl).origin) out.add(normalizePath(u.pathname));
    } catch {
      /* ignore malformed links */
    }
  }
  return Array.from(out);
}

function normalizePath(p: string): string {
  const clean = "/" + p.replace(/^\/+|\/+$/g, "");
  return clean === "/" ? "/" : clean + "/";
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (!m) return undefined;
  return decodeEntities(m[1]).trim();
}

async function getFrontmatterTitle(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return undefined;
    const t = m[1].match(/^title:\s*(.+)$/m);
    return t ? t[1].replace(/^["']|["']$/g, "").trim() : undefined;
  } catch {
    return undefined;
  }
}

function titlesMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
  return norm(a).includes(norm(b)) || norm(b).includes(norm(a));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function singular(name: string): string {
  if (name.endsWith("ies")) return name.slice(0, -3) + "y";
  if (name.endsWith("s")) return name.slice(0, -1);
  return name;
}
