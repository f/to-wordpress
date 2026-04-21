import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MigrationContext } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import { wpCli } from "../wp/wpEnv.js";

export interface VerifyIssue {
  kind: "missing_post" | "http_error" | "title_mismatch" | "count_mismatch" | "other";
  path?: string;
  expected?: string;
  actual?: string;
  message: string;
}

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
  for (const item of sample) {
    const url = new URL(item.originalPermalink, ctx.wpUrl).toString();
    const res = await fetchSafe(url);
    if (!res) {
      issues.push({ kind: "http_error", path: item.originalPermalink, message: `fetch failed for ${url}` });
      continue;
    }
    if (res.status >= 400) {
      issues.push({
        kind: "http_error",
        path: item.originalPermalink,
        message: `status ${res.status} for ${url}`,
      });
      continue;
    }
    const title = extractTitle(res.body);
    const srcParsed = await getFrontmatterTitle(item.path);
    if (srcParsed && title && !titlesMatch(title, srcParsed)) {
      issues.push({
        kind: "title_mismatch",
        path: item.originalPermalink,
        expected: srcParsed,
        actual: title,
        message: `title mismatch at ${item.originalPermalink}`,
      });
    }
  }

  const report: VerifyReport = {
    wpUrl: ctx.wpUrl,
    ok: issues.length === 0,
    checked: sample.length,
    issues,
    countsBySource,
    countsByWp,
  };

  const reportPath = join(ctx.workDir, "verify-report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  bus.pushStreamEvent("verify", {
    type: "info",
    phase: "verify",
    message: `checked ${sample.length} urls; ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
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
