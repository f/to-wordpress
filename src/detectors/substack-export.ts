import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, walkAll } from "./common.js";

/**
 * Substack export detector. The ZIP unpacks into `posts.csv` (metadata)
 * plus `posts/<id>.html` (bodies). The conversion prompt joins them on
 * post_id so each WordPress post has the right title, slug, publish
 * date, and subscriber-only flag.
 */
export const substackExportDetector: Detector = {
  name: "substack-export",
  priority: 77,

  async match(dir) {
    const csv = join(dir, "posts.csv");
    const postsDir = join(dir, "posts");
    if (!existsSync(csv) || !existsSync(postsDir)) return 0;
    try {
      const head = (await readFile(csv, "utf8")).slice(0, 512);
      if (/post_id,post_date|^id,title,subtitle/i.test(head)) return 0.93;
    } catch {
      /* ignore */
    }
    const files = await walkAll(postsDir, 2);
    const htmls = files.filter((f) => /\.html$/i.test(f));
    if (htmls.length > 0) return 0.75;
    return 0;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "substack-export";
    out.siteTitle = "Substack Import";

    const csv = join(dir, "posts.csv");
    const postsDir = join(dir, "posts");
    const htmls = existsSync(postsDir)
      ? (await walkAll(postsDir, 2)).filter((f) => /\.html$/i.test(f))
      : [];

    out.rawSources = [
      { path: csv, format: "substack", postType: "post", hint: "manifest" },
      ...htmls.map((p) => ({ path: p, format: "substack" as const, postType: "post", hint: "body" })),
    ];
    out.collections.push({
      name: "posts",
      dir: postsDir,
      permalink: "/p/:slug/",
      count: htmls.length,
    });
    out.detectorBriefing =
      `Source is a Substack export. Join posts.csv (id,post_date,title,subtitle,type,` +
      `is_published,audience,paywall_url,email_sent_at) with posts/<id>.html. ` +
      `Map type=podcast → podcast CPT, audience=only_paid → private, ` +
      `type=newsletter with subtitle → use subtitle as excerpt. Strip Substack's ` +
      `"Thanks for reading!" footer before importing.`;
    return out;
  },
};
