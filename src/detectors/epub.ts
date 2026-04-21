import { basename } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, countByExt, walkAll } from "./common.js";

/**
 * EPUB ebook detector. A single `.epub` becomes a WordPress site where
 * each chapter is a post (or a page) and the ebook metadata (title,
 * author, cover) populates the site identity. Multiple `.epub` files
 * become multiple "book" CPTs.
 */
export const epubDetector: Detector = {
  name: "epub-book",
  priority: 50,

  async match(dir) {
    const files = await walkAll(dir, 3);
    const counts = countByExt(files);
    const epubs = counts[".epub"] ?? 0;
    if (epubs === 0) return 0;
    const otherContent =
      (counts[".md"] ?? 0) + (counts[".html"] ?? 0) + (counts[".mdx"] ?? 0);
    if (epubs >= 1 && otherContent === 0) return 0.82;
    return 0.35;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "epub-book";
    out.siteTitle = basename(dir).replace(/[-_]+/g, " ");

    const files = await walkAll(dir, 6);
    const epubs = files.filter((f) => /\.epub$/i.test(f));
    out.rawSources = epubs.map((path) => ({
      path,
      format: "epub",
      postType: "post",
    }));
    out.collections.push({
      name: "posts",
      dir,
      permalink: "/chapter/:slug/",
      count: epubs.length,
    });
    out.detectorBriefing =
      `Source is a library of ${epubs.length} EPUB ebook(s). For each ebook: extract ` +
      `title, author, cover image (opf metadata) — those populate the site/book ` +
      `identity. Each chapter (spine item) becomes a post whose title is the chapter ` +
      `heading and whose body is the chapter's xhtml content.`;
    return out;
  },
};
