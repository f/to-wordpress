import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, walkAll } from "./common.js";

/**
 * WordPress WXR export detector. Triggers when the source folder has
 * one or more `.xml` files that look like WordPress' native export
 * format ("WordPress eXtended RSS"). This is the "WordPress ↔ WordPress"
 * migration case: a customer is moving from WordPress.com (or another
 * host) to a self-hosted wp-env locally.
 *
 * Each <item> in the WXR becomes a markdown file before normalize sees
 * it (via `convert-wxr.md`).
 */
export const wpWxrDetector: Detector = {
  name: "wp-wxr",
  priority: 80,

  async match(dir) {
    const files = await walkAll(dir, 4);
    const xmls = files.filter((f) => /\.xml$/i.test(f));
    if (xmls.length === 0) return 0;
    for (const x of xmls) {
      try {
        const head = (await readFile(x, "utf8")).slice(0, 2048);
        if (/wp:wxr_version|xmlns:wp="http:\/\/wordpress\.org\/export/.test(head)) {
          return 0.97;
        }
      } catch {
        /* keep scanning */
      }
    }
    return 0;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "wp-wxr";
    out.siteTitle = basename(dir).replace(/[-_]+/g, " ");

    const files = await walkAll(dir, 4);
    const xmls: string[] = [];
    for (const f of files.filter((x) => /\.xml$/i.test(x))) {
      try {
        const head = (await readFile(f, "utf8")).slice(0, 2048);
        if (/wp:wxr_version|xmlns:wp="http:\/\/wordpress\.org\/export/.test(head)) {
          xmls.push(f);
        }
      } catch {
        /* skip */
      }
    }
    out.rawSources = xmls.map((path) => ({
      path,
      format: "wxr",
      postType: "post",
    }));
    out.collections.push({
      name: "posts",
      dir,
      permalink: "/:slug/",
      count: xmls.length,
    });
    out.detectorBriefing =
      `Source is a WordPress WXR export (${xmls.length} file(s)). Parse each <item>: ` +
      `<title> → post title, <wp:post_name> → slug, <content:encoded> → body, ` +
      `<wp:status> → status, <wp:post_type> → post_type, <category> → categories/tags, ` +
      `<wp:postmeta> → custom fields. Keep the original publish date and author. ` +
      `Images referenced inside <content:encoded> should be sideloaded as WordPress ` +
      `attachments.`;
    return out;
  },
};
