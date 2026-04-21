import { basename } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, countByExt, readCname, walkAll } from "./common.js";

/**
 * PDF bundle detector. The source is a folder of PDFs (whitepapers,
 * reports, manuals, book chapters). Each PDF becomes a WordPress post
 * using the `src/prompts/convert-pdf.md` prompt, which tells Copilot
 * to extract sections as headings, figures as image blocks, and keep
 * pagination metadata as post meta.
 */
export const pdfDetector: Detector = {
  name: "pdf-folder",
  priority: 33,

  async match(dir) {
    const files = await walkAll(dir, 6);
    const counts = countByExt(files);
    const pdfCount = counts[".pdf"] ?? 0;
    if (pdfCount === 0) return 0;
    const otherContent =
      (counts[".md"] ?? 0) +
      (counts[".html"] ?? 0) +
      (counts[".mdx"] ?? 0) +
      (counts[".docx"] ?? 0);
    if (pdfCount >= 1 && otherContent === 0) return 0.85;
    if (pdfCount >= otherContent * 2) return 0.55;
    return 0.25;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "pdf-folder";
    out.siteTitle = basename(dir).replace(/[-_]+/g, " ");
    out.domain = await readCname(dir);

    const files = await walkAll(dir, 8);
    const pdfs = files.filter((f) => /\.pdf$/i.test(f));
    out.rawSources = pdfs.map((path) => ({
      path,
      format: "pdf",
      postType: "post",
    }));
    out.collections.push({
      name: "posts",
      dir,
      permalink: "/:slug/",
      count: pdfs.length,
    });
    out.detectorBriefing =
      `Source is a library of ${pdfs.length} PDF document(s). Extract the title from ` +
      `the PDF metadata or the first heading; extract the body preserving section ` +
      `hierarchy as H2/H3; extract embedded images as Gutenberg image blocks. ` +
      `Keep page numbers out of the body text — readers shouldn't see them.`;
    return out;
  },
};
