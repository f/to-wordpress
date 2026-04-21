import { basename } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, countByExt, walkAll } from "./common.js";

/**
 * Plain-text / RST / misc "text files with maybe structure" detector.
 * Last resort before freestyle for bags of `.txt` (or `.rst`) files:
 * think chat logs, letters, old CMS dumps, scraped articles.
 */
export const textFolderDetector: Detector = {
  name: "text-folder",
  priority: 10,

  async match(dir) {
    const files = await walkAll(dir, 5);
    const counts = countByExt(files);
    const textCount = (counts[".txt"] ?? 0) + (counts[".rst"] ?? 0);
    if (textCount === 0) return 0;
    const otherContent =
      (counts[".md"] ?? 0) +
      (counts[".html"] ?? 0) +
      (counts[".mdx"] ?? 0) +
      (counts[".docx"] ?? 0) +
      (counts[".pdf"] ?? 0) +
      (counts[".xlsx"] ?? 0);
    if (textCount >= 3 && otherContent === 0) return 0.6;
    if (textCount >= otherContent) return 0.3;
    return 0.15;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "text-folder";
    out.siteTitle = basename(dir).replace(/[-_]+/g, " ");

    const files = await walkAll(dir, 8);
    const texts = files.filter((f) => /\.(txt|rst)$/i.test(f));
    out.rawSources = texts.map((path) => ({
      path,
      format: "txt",
      postType: "post",
    }));
    out.collections.push({
      name: "posts",
      dir,
      permalink: "/:slug/",
      count: texts.length,
    });
    out.detectorBriefing =
      `Source is a folder of ${texts.length} plain-text document(s). Use the first ` +
      `non-empty line as the title. Preserve paragraph breaks (blank lines). Auto-link ` +
      `URLs. If a filename has the form "YYYY-MM-DD*.txt", use that as the publish date.`;
    return out;
  },
};
