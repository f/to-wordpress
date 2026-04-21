import { basename, dirname, relative } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, readCname, walkAll } from "./common.js";

/**
 * "Just a folder of markdown files" detector. Catches the long tail of
 * writers' Obsidian/Notion exports, Zettelkasten dumps, note piles,
 * personal wikis, and any other bag of `.md` files that isn't a full
 * SSG. The normalize phase treats each file as a post, using front-
 * matter if present or filename/first-heading otherwise.
 *
 * Priority is deliberately below the concrete SSG detectors (jekyll,
 * hugo, eleventy) so that a Jekyll site's `_posts/` folder doesn't get
 * mislabelled as a generic markdown folder.
 */
export const markdownFolderDetector: Detector = {
  name: "markdown-folder",
  priority: 18,

  async match(dir) {
    const files = await walkAll(dir, 6);
    const md = files.filter((f) => /\.(md|markdown|mdx)$/i.test(f));
    if (md.length === 0) return 0;
    // Jekyll / Hugo / Eleventy signals — if seen, bow out.
    const hasJekyll = files.some((f) => /\/(_config\.(yml|toml)|_posts)\b/.test(f));
    const hasHugo = files.some((f) => /\/(hugo\.(toml|yaml)|config\.(toml|yaml))/.test(f));
    const hasEleventy = files.some((f) => /\/\.eleventy\.js|eleventy\.config\./.test(f));
    if (hasJekyll || hasHugo || hasEleventy) return 0;
    // README-dominant folders are better handled by `github-repo`.
    const hasReadme = files.some((f) => /\/readme\.(md|mdx)$/i.test(f));
    if (hasReadme && md.length <= 3) return 0;
    if (md.length >= 10) return 0.65;
    if (md.length >= 3) return 0.45;
    return 0.3;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "markdown-folder";
    out.siteTitle = basename(dir).replace(/[-_]+/g, " ");
    out.domain = await readCname(dir);

    const files = await walkAll(dir, 10);
    const md = files.filter((f) => /\.(md|markdown|mdx)$/i.test(f));

    // Group by directory to spot collections (e.g. `posts/`, `notes/`,
    // `daily/`) that show up as ≥3 files under the same folder.
    const byDir = new Map<string, string[]>();
    for (const f of md) {
      const d = dirname(f);
      byDir.set(d, [...(byDir.get(d) ?? []), f]);
    }
    const groups = [...byDir.entries()].sort((a, b) => b[1].length - a[1].length);
    const collections: typeof out.collections = [];
    const pageFiles = new Set<string>();

    for (const [d, entries] of groups) {
      if (entries.length < 3) {
        entries.forEach((e) => pageFiles.add(e));
        continue;
      }
      const rel = relative(dir, d) || "posts";
      const name = rel
        .split("/")
        .filter(Boolean)
        .join("-")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "posts";
      collections.push({
        name: name === "_posts" ? "posts" : name,
        dir: d,
        permalink: name === "posts" ? "/:slug/" : `/${name}/:slug/`,
        count: entries.length,
      });
    }
    if (collections.length === 0) {
      collections.push({ name: "posts", dir, permalink: "/:slug/", count: md.length });
    }
    out.collections = collections;
    out.pages = [...pageFiles];
    out.detectorBriefing =
      `Source is a free-form folder of ${md.length} markdown files (looks like ` +
      `notes, Obsidian vault, Notion export, or a simple writing archive). Map ` +
      `folders with 3+ files to collections; stray markdown files become standalone ` +
      `pages. Preserve [[wikilinks]] as internal links and convert Obsidian callouts ` +
      `(">[!note]") to Gutenberg group blocks.`;
    return out;
  },
};
