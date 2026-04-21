import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, readPackageJson, walkAll } from "./common.js";

/**
 * Astro detector — `astro.config.*` + `src/content/` (content
 * collections) + `src/pages/`. Astro supports `.astro`, `.mdx`, and
 * `.md` files; we inventory all three so the theme phase has a
 * faithful snapshot of the component tree.
 */
export const astroDetector: Detector = {
  name: "astro",
  priority: 70,

  async match(dir) {
    const hasConfig = ["astro.config.mjs", "astro.config.ts", "astro.config.js"].some((f) =>
      existsSync(join(dir, f)),
    );
    const pkg = await readPackageJson(dir);
    const depends = { ...((pkg?.dependencies ?? {}) as Record<string, string>), ...((pkg?.devDependencies ?? {}) as Record<string, string>) };
    const hasAstroDep = Boolean(depends.astro);
    if (hasConfig && hasAstroDep) return 0.95;
    if (hasConfig || hasAstroDep) return 0.7;
    return 0;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "astro";

    const all = await walkAll(dir, 6);
    out.layouts = all.filter((f) => /\.astro$/i.test(f));

    // Content collections live in src/content/<collection>/*.md(x).
    const contentDir = join(dir, "src", "content");
    if (existsSync(contentDir)) {
      const byCol = new Map<string, string[]>();
      for (const f of all.filter((f) => f.startsWith(contentDir))) {
        if (!/\.(md|mdx|markdown)$/i.test(f)) continue;
        const rel = f.slice(contentDir.length + 1);
        const name = rel.split("/")[0];
        byCol.set(name, [...(byCol.get(name) ?? []), f]);
      }
      for (const [name, files] of byCol) {
        out.collections.push({
          name: name === "blog" ? "posts" : name,
          dir: join(contentDir, name),
          permalink: name === "blog" ? "/blog/:slug/" : `/${name}/:slug/`,
          count: files.length,
        });
      }
    }

    // Stand-alone pages live in src/pages/.
    const pagesDir = join(dir, "src", "pages");
    if (existsSync(pagesDir)) {
      out.pages = all
        .filter((f) => f.startsWith(pagesDir))
        .filter((f) => /\.(md|mdx|astro)$/i.test(f));
    }

    out.assetsDirs = ["public", "src/assets", "src/images"]
      .map((p) => join(dir, p))
      .filter((p) => existsSync(p));
    out.detectorBriefing =
      `Source is an Astro site. Content collections under src/content/ each map to a ` +
      `WordPress collection; files under src/pages/ map to WordPress pages. ` +
      `.astro files are React-like component templates — read their HTML and ` +
      `inline styles for theme fidelity; ignore their imports/scripts.`;
    return out;
  },
};
