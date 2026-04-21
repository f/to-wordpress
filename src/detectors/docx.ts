import { basename } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, countByExt, readCname, walkAll } from "./common.js";

/**
 * Word-document bundle detector. Triggers when the source is a folder
 * whose content is dominated by `.docx` (or `.doc` / `.rtf`) files.
 *
 * Each Word file becomes a WordPress post: the normalize phase passes
 * it through `src/prompts/convert-docx.md` to extract a title, body,
 * and any inline media, producing a canonical markdown file.
 */
export const docxDetector: Detector = {
  name: "docx-folder",
  priority: 35,

  async match(dir) {
    const files = await walkAll(dir, 6);
    const counts = countByExt(files);
    const wordCount = (counts[".docx"] ?? 0) + (counts[".doc"] ?? 0) + (counts[".rtf"] ?? 0);
    if (wordCount === 0) return 0;
    const otherContent =
      (counts[".md"] ?? 0) +
      (counts[".html"] ?? 0) +
      (counts[".mdx"] ?? 0) +
      (counts[".pdf"] ?? 0);
    // Clear-cut Word archive.
    if (wordCount >= 3 && wordCount >= otherContent * 2) return 0.9;
    if (wordCount >= 1 && otherContent === 0) return 0.8;
    if (wordCount > otherContent) return 0.55;
    return 0.25;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "docx-folder";
    out.siteTitle = deriveSiteTitle(dir);
    out.domain = await readCname(dir);

    const files = await walkAll(dir, 8);
    const wordFiles = files.filter((f) => /\.(docx|doc|rtf)$/i.test(f));
    out.pages = [];
    out.rawSources = wordFiles.map((path) => ({
      path,
      format: "docx",
      postType: "post",
    }));
    out.collections.push({
      name: "posts",
      dir,
      permalink: "/:slug/",
      count: wordFiles.length,
    });
    out.detectorBriefing =
      `This site is being migrated from a folder of ${wordFiles.length} Microsoft Word ` +
      `documents. Treat each Word file as one WordPress post: its first heading (or the ` +
      `filename) becomes the post title, the rest of the document becomes the body, and ` +
      `embedded images become media attachments.`;
    return out;
  },
};

function deriveSiteTitle(dir: string): string {
  return basename(dir)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
