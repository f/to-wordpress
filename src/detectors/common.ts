import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { DetectedContext } from "../types.js";

export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".cache",
  ".next",
  ".nuxt",
  ".vercel",
  ".netlify",
  ".turbo",
  ".parcel-cache",
  "dist",
  "build",
  "out",
  "public",
  "_site",
  ".jekyll-cache",
  ".sass-cache",
  "vendor",
  "tmp",
  ".wp-env",
  "WORDPRESS_MIGRATION",
]);

export const CONTENT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".html",
  ".htm",
  ".njk",
  ".liquid",
  ".hbs",
  ".ejs",
  ".pug",
]);

export async function listFiles(dir: string, ext?: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    try {
      const entries = await readdir(cur, { withFileTypes: true, encoding: "utf8" });
      for (const e of entries) {
        const p = join(cur, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (!ext || p.toLowerCase().endsWith(ext)) out.push(p);
      }
    } catch {
      continue;
    }
  }
  return out.sort();
}

export async function walkAll(dir: string, maxDepth = 6): Promise<string[]> {
  const out: string[] = [];
  const stack: Array<{ p: string; d: number }> = [{ p: dir, d: 0 }];
  while (stack.length) {
    const { p, d } = stack.pop()!;
    if (d > maxDepth) continue;
    try {
      const entries = await readdir(p, { withFileTypes: true, encoding: "utf8" });
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = join(p, e.name);
        if (e.isDirectory()) stack.push({ p: full, d: d + 1 });
        else out.push(full);
      }
    } catch {
      continue;
    }
  }
  return out;
}

export async function readCname(dir: string): Promise<string | undefined> {
  const cnamePath = join(dir, "CNAME");
  if (!existsSync(cnamePath)) return undefined;
  const raw = (await readFile(cnamePath, "utf8")).trim();
  return raw ? `https://${raw.replace(/^https?:\/\//, "")}` : undefined;
}

export async function readPackageJson(
  dir: string,
): Promise<Record<string, unknown> | undefined> {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function deriveThemeSlug(dir: string): string {
  const name = basename(dir)
    .toLowerCase()
    .replace(/\.github\.io$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name || "migrated";
}

export function baseContext(dir: string): DetectedContext {
  const slug = deriveThemeSlug(dir);
  return {
    sourceDir: dir,
    kind: "unknown",
    themeSlug: slug,
    pluginSlug: slug + "-site",
    layouts: [],
    includes: [],
    sassFiles: [],
    assetsDirs: [],
    dataFiles: [],
    ssgPlugins: [],
    collections: [],
    pages: [],
    frontMatterKeys: [],
    features: {},
  };
}

export function hasAny(paths: string[], roots: string[]): boolean {
  return roots.some((r) => paths.some((p) => p.includes(`/${r}/`) || p.endsWith(`/${r}`)));
}

export function existsAny(dir: string, names: string[]): boolean {
  return names.some((n) => existsSync(join(dir, n)));
}
