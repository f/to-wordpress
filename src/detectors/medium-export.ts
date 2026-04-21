import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, walkAll } from "./common.js";

/**
 * Medium export detector. The ZIP that Medium gives you unpacks into a
 * top-level folder with `posts/*.html`, `profile/`, `bookmarks/`, etc.
 * Each post HTML has a standard wrapper (h1 title, byline, body) that
 * `convert-medium-html.md` knows how to parse.
 */
export const mediumExportDetector: Detector = {
  name: "medium-export",
  priority: 78,

  async match(dir) {
    const postsDir = join(dir, "posts");
    if (!existsSync(postsDir)) return 0;
    const files = await walkAll(postsDir, 2);
    const htmls = files.filter((f) => /\.html$/i.test(f));
    if (htmls.length === 0) return 0;
    // Medium posts are named with a date prefix:
    //   2019-07-15_My-Post-Title-<hash>.html
    const looksMedium = htmls
      .slice(0, 5)
      .some((f) => /\d{4}-\d{2}-\d{2}_.*-[0-9a-f]{8,}\.html$/i.test(f));
    if (looksMedium) return 0.94;
    // Fallback sniff: first file has Medium's characteristic <h3 class="graf">.
    try {
      const head = (await readFile(htmls[0], "utf8")).slice(0, 4096);
      if (/graf graf--h3 graf--leading|class="p-name"/.test(head)) return 0.88;
    } catch {
      /* ignore */
    }
    return 0.3;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "medium-export";
    out.siteTitle = "Medium Import";

    const postsDir = join(dir, "posts");
    const files = existsSync(postsDir) ? await walkAll(postsDir, 2) : [];
    const htmls = files.filter((f) => /\.html$/i.test(f));
    const drafts = htmls.filter((f) => /\/draft_/i.test(f));
    const published = htmls.filter((f) => !drafts.includes(f));
    out.rawSources = [
      ...published.map((p) => ({ path: p, format: "medium-html" as const, postType: "post", hint: "publish" })),
      ...drafts.map((p) => ({ path: p, format: "medium-html" as const, postType: "post", hint: "draft" })),
    ];
    out.collections.push({
      name: "posts",
      dir: postsDir,
      permalink: "/:slug/",
      count: htmls.length,
    });
    out.detectorBriefing =
      `Source is a Medium export. Each HTML file has: <h1 class="p-name"> title, ` +
      `<section data-field="body"> body, <a rel="author"> author, <time class="dt-published">. ` +
      `Strip the "This post was published on Medium" footer, convert Medium's figure captions ` +
      `to Gutenberg image blocks with caption, and preserve any embedded gists / tweets as ` +
      `appropriate Gutenberg embeds.`;
    return out;
  },
};
