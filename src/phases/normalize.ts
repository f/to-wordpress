import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import matter from "gray-matter";
import { stringify as yamlStringify } from "yaml";
import type { MigrationContext, UserChoices, DetectedContext } from "../types.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import { runCopilotPhase } from "./theme.js";
import type { UiBus } from "../tui/bus.js";

export interface NormalizedRef {
  postType: string;
  slug: string;
  path: string;
  originalPermalink: string;
  sourcePath: string;
}

export interface NormalizeResult {
  items: NormalizedRef[];
  mediaCopied: string[];
  failures: Array<{ sourcePath: string; targetPath: string; error: string }>;
}

export async function runNormalize(ctx: MigrationContext, bus: UiBus): Promise<NormalizeResult> {
  bus.pushStreamEvent("normalize", { type: "phase_start", phase: "normalize", message: "measuring the meter — polishing every verse to the same line-length" });
  const detected = ctx.detected;
  const choices = ctx.choices;
  if (!detected || !choices) throw new Error("plan phase must run before normalize");

  await mkdir(ctx.contentDir, { recursive: true });
  await mkdir(ctx.mediaDir, { recursive: true });

  const items: NormalizedRef[] = [];
  const mediaCopied = new Set<string>();
  const failures: NormalizeResult["failures"] = [];

  for (const coll of detected.collections) {
    const postType = resolvePostType(coll.name, choices);
    const files = await listMdFiles(coll.dir);
    for (const src of files) {
      try {
        const ref = await normalizeOne(src, postType, coll.permalink ?? "/:slug/", ctx, detected, mediaCopied);
        items.push(ref);
      } catch (err) {
        failures.push({ sourcePath: src, targetPath: "", error: (err as Error).message });
      }
    }
  }
  for (const src of detected.pages) {
    try {
      const ref = await normalizeOne(src, "page", "/:basename/", ctx, detected, mediaCopied);
      items.push(ref);
    } catch (err) {
      failures.push({ sourcePath: src, targetPath: "", error: (err as Error).message });
    }
  }

  bus.pushStreamEvent("normalize", {
    type: "info",
    phase: "normalize",
    message: `normalized ${items.length} items, ${mediaCopied.size} media, ${failures.length} failures`,
  });

  if (failures.length > 0) {
    bus.pushStreamEvent("normalize", {
      type: "info",
      phase: "normalize",
      message: `invoking copilot on ${failures.length} edge case${failures.length === 1 ? "" : "s"}`,
    });
    const tpl = await loadPrompt("normalize-edge");
    for (const f of failures) {
      const rel = relative(detected.sourceDir, f.sourcePath).replace(/\.(md|markdown|mdx)$/i, "");
      const targetPath = join(ctx.contentDir, "post", slugify(basename(rel)) + ".md");
      f.targetPath = targetPath;
      const prompt = interpolate(tpl, {
        SOURCE_FILE: f.sourcePath,
        TARGET_FILE: targetPath,
        POST_TYPE: "post",
      });
      const result = await runCopilotPhase(bus, "normalize", {
        prompt,
        cwd: ctx.sourceDir,
        addDirs: [ctx.sourceDir, ctx.workDir],
        resumeSessionId: ctx.copilotSessionId,
        maxAutopilotContinues: 20,
        timeoutMs: 5 * 60 * 1000,
      });
      if (result.sessionId) ctx.copilotSessionId = result.sessionId;
      if (existsSync(targetPath)) {
        items.push({
          postType: "post",
          slug: slugify(basename(rel)),
          path: targetPath,
          originalPermalink: "/blog/" + slugify(basename(rel)) + "/",
          sourcePath: f.sourcePath,
        });
      }
    }
  }

  await writeFile(
    join(ctx.contentDir, "index.json"),
    JSON.stringify({ items, failures }, null, 2) + "\n",
    "utf8",
  );

  bus.pushStreamEvent("normalize", { type: "phase_ok", phase: "normalize" });
  return { items, mediaCopied: [...mediaCopied], failures };
}

async function normalizeOne(
  srcPath: string,
  postType: string,
  permalinkTpl: string,
  ctx: MigrationContext,
  detected: DetectedContext,
  mediaCopied: Set<string>,
): Promise<NormalizedRef> {
  const raw = await readFile(srcPath, "utf8");
  const parsed = matter(raw);
  const filename = basename(srcPath, extname(srcPath));
  const { date, slug } = extractDateAndSlug(filename, parsed.data);
  const title = (parsed.data.title as string | undefined) ?? humanize(slug);
  const categories = toStringArray(parsed.data.categories ?? parsed.data.category);
  const tags = toStringArray(parsed.data.tags ?? parsed.data.tag);
  const originalPermalink = buildPermalink(permalinkTpl, { slug, date, basename: filename, category: categories[0] });
  const featured = (parsed.data.image as string | undefined) ?? (parsed.data.featured_image as string | undefined);

  let body = parsed.content;
  const { body: body2, copied } = await rewriteMedia(body, srcPath, detected, ctx);
  for (const c of copied) mediaCopied.add(c);
  body = body2;

  for (const key of ["featured_image", "image", "thumbnail", "meta_image"] as const) {
    const ref = parsed.data[key];
    if (typeof ref === "string" && ref.length > 0) {
      const copiedPath = await copyMediaRef(ref, srcPath, detected, ctx);
      if (copiedPath) mediaCopied.add(copiedPath);
    }
  }

  const layout = (parsed.data.layout as string | undefined) ?? undefined;
  const description = (parsed.data.description as string | undefined) ?? undefined;
  const normalized = {
    title,
    slug,
    date,
    updated: (parsed.data.updated as string | undefined) ?? undefined,
    author: (parsed.data.author as string | undefined) ?? undefined,
    status: (parsed.data.published === false ? "draft" : "publish") as "publish" | "draft",
    excerpt: (parsed.data.excerpt as string | undefined) ?? description,
    categories,
    tags,
    featured_image: featured,
    post_type: postType,
    original_permalink: originalPermalink,
    source_path: resolve(srcPath),
    layout,
  };

  const targetDir = join(ctx.contentDir, postType);
  await mkdir(targetDir, { recursive: true });
  const targetPath = join(targetDir, `${slug}.md`);
  await writeFile(targetPath, `---\n${yamlStringify(normalized)}---\n\n${body.trim()}\n`, "utf8");

  return {
    postType,
    slug,
    path: targetPath,
    originalPermalink,
    sourcePath: resolve(srcPath),
  };
}

const MEDIA_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Copy a single media reference (as found in a front-matter field like
 * `featured_image` or `image`) from the source tree into the media dir.
 * Returns the absolute path of the copied file, or undefined if the
 * reference could not be resolved.
 */
async function copyMediaRef(
  ref: string,
  srcPath: string,
  detected: DetectedContext,
  ctx: MigrationContext,
): Promise<string | undefined> {
  if (/^https?:\/\//i.test(ref) || ref.startsWith("data:")) return undefined;
  const abs = resolveRef(ref, srcPath, detected.sourceDir);
  if (!abs || !existsSync(abs)) return undefined;
  const rel = relative(detected.sourceDir, abs).replaceAll("\\", "/");
  const flat = rel.replace(/\//g, "__");
  const target = join(ctx.mediaDir, flat);
  if (!existsSync(target)) await copyFile(abs, target);
  return target;
}

async function rewriteMedia(
  body: string,
  srcPath: string,
  detected: DetectedContext,
  ctx: MigrationContext,
): Promise<{ body: string; copied: string[] }> {
  const copied: string[] = [];
  const out = await replaceAsync(body, MEDIA_RE, async (whole, alt: string, url: string) => {
    if (/^https?:\/\//i.test(url) || url.startsWith("data:")) return whole;
    const abs = resolveRef(url, srcPath, detected.sourceDir);
    if (!abs || !existsSync(abs)) return whole;
    const rel = relative(detected.sourceDir, abs).replaceAll("\\", "/");
    const flat = rel.replace(/\//g, "__");
    const target = join(ctx.mediaDir, flat);
    if (!existsSync(target)) await copyFile(abs, target);
    copied.push(target);
    return `![${alt}](media:${flat})`;
  });
  return { body: out, copied };
}

function resolveRef(url: string, srcPath: string, sourceRoot: string): string | undefined {
  if (url.startsWith("/")) return join(sourceRoot, url);
  return resolve(dirname(srcPath), url);
}

async function replaceAsync(
  s: string,
  re: RegExp,
  repl: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const matches: Array<{ match: RegExpExecArray; replacement: string }> = [];
  for (const m of s.matchAll(re)) {
    const replacement = await repl(m[0], ...m.slice(1));
    matches.push({ match: m as RegExpExecArray, replacement });
  }
  let out = "";
  let lastIndex = 0;
  for (const { match, replacement } of matches) {
    out += s.slice(lastIndex, match.index) + replacement;
    lastIndex = match.index + match[0].length;
  }
  out += s.slice(lastIndex);
  return out;
}

function extractDateAndSlug(
  filename: string,
  data: Record<string, unknown>,
): { date: string; slug: string } {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  const date = (data.date as string | undefined) ?? (m ? `${m[1]}T00:00:00Z` : new Date().toISOString());
  const slug = (data.slug as string | undefined) ?? (m ? slugify(m[2]) : slugify(filename));
  return { date: normalizeDate(date), slug };
}

function normalizeDate(d: string): string {
  const t = new Date(d);
  if (isNaN(t.getTime())) return new Date().toISOString();
  return t.toISOString();
}

function buildPermalink(
  tpl: string,
  vars: { slug: string; date: string; basename: string; category?: string },
): string {
  return tpl
    .replace(/:slug/g, vars.slug)
    .replace(/:basename/g, slugify(vars.basename))
    .replace(/:path/g, vars.slug)
    .replace(/:year/g, vars.date.slice(0, 4))
    .replace(/:month/g, vars.date.slice(5, 7))
    .replace(/:day/g, vars.date.slice(8, 10))
    .replace(/:category/g, vars.category ? slugify(vars.category) : "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "/");
}

function resolvePostType(collectionName: string, choices: UserChoices): string {
  if (collectionName === "posts") return "post";
  const cpt = choices.customPostTypes.find((c) => c.name === collectionName);
  return cpt ? cpt.slug : "post";
}

async function listMdFiles(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = await readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.(md|markdown|mdx)$/i.test(p)) out.push(p);
    }
  }
  return out.sort();
}

function toStringArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(/[,;\s]+/).filter(Boolean);
  return [];
}

function humanize(s: string): string {
  return s
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
