import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, readCname, walkAll } from "./common.js";

export const plainHtmlDetector: Detector = {
  name: "plain-html",
  priority: 20,

  async match(dir) {
    const files = await walkAll(dir, 4);
    const html = files.filter((f) => /\.html?$/i.test(f));
    const md = files.filter((f) => /\.(md|markdown|mdx)$/i.test(f));
    if (html.length === 0) return 0;
    // If markdown dominates, this is not a plain-HTML site — let the freestyle
    // detector handle it so we discover markdown collections properly.
    if (md.length >= html.length) return 0;
    if (existsSync(join(dir, "index.html")) && html.length >= 3) return 0.5;
    if (html.length >= 3) return 0.35;
    return 0.2;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "plain-html";
    out.domain = await readCname(dir);

    const files = await walkAll(dir, 8);
    out.layouts = files.filter((f) => /\.html?$/i.test(f));
    out.pages = files.filter((f) => /\.(md|markdown|mdx)$/i.test(f));

    if (out.layouts.length > 0 && out.collections.length === 0) {
      out.collections.push({
        name: "pages",
        dir,
        permalink: "/:basename/",
        count: out.layouts.length,
      });
    }

    const assetsDirs = new Set<string>();
    for (const f of files) {
      const rel = relative(dir, f);
      if (/^(assets|static|public|images|img|media|css|js)\//.test(rel)) {
        const root = rel.split("/")[0];
        assetsDirs.add(join(dir, root));
      }
    }
    out.assetsDirs = [...assetsDirs];

    return out;
  },
};
