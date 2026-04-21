import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, readPackageJson, walkAll } from "./common.js";

/**
 * Docusaurus detector — `docusaurus.config.(js|ts)` + `docs/` + `blog/`.
 * Docs are sidebar-organized markdown; blog posts are date-prefixed
 * or MDX with front-matter.
 */
export const docusaurusDetector: Detector = {
  name: "docusaurus",
  priority: 72,

  async match(dir) {
    const hasConfig = ["docusaurus.config.js", "docusaurus.config.ts"].some((f) =>
      existsSync(join(dir, f)),
    );
    const pkg = await readPackageJson(dir);
    const depends = { ...((pkg?.dependencies ?? {}) as Record<string, string>), ...((pkg?.devDependencies ?? {}) as Record<string, string>) };
    const hasDep = Object.keys(depends).some((d) => d.startsWith("@docusaurus/"));
    if (hasConfig && hasDep) return 0.97;
    if (hasConfig || hasDep) return 0.7;
    return 0;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "docusaurus";

    const all = await walkAll(dir, 6);

    const docsDir = join(dir, "docs");
    if (existsSync(docsDir)) {
      const docs = all.filter((f) => f.startsWith(docsDir) && /\.(md|mdx)$/i.test(f));
      if (docs.length > 0) {
        out.collections.push({
          name: "docs",
          dir: docsDir,
          permalink: "/docs/:slug/",
          count: docs.length,
        });
      }
    }
    const blogDir = join(dir, "blog");
    if (existsSync(blogDir)) {
      const posts = all.filter((f) => f.startsWith(blogDir) && /\.(md|mdx)$/i.test(f));
      if (posts.length > 0) {
        out.collections.push({
          name: "posts",
          dir: blogDir,
          permalink: "/blog/:slug/",
          count: posts.length,
        });
      }
    }
    const srcPages = join(dir, "src", "pages");
    if (existsSync(srcPages)) {
      out.pages = all
        .filter((f) => f.startsWith(srcPages))
        .filter((f) => /\.(md|mdx)$/i.test(f));
    }

    out.assetsDirs = ["static", "static/img", "docs/img"]
      .map((p) => join(dir, p))
      .filter((p) => existsSync(p));
    out.detectorBriefing =
      `Source is a Docusaurus documentation site. Map docs/ to the "docs" collection ` +
      `(preserve sidebar_position in post meta), blog/ to "posts", and src/pages/*.mdx ` +
      `to standalone pages. Admonitions (":::note", ":::tip") must be translated to ` +
      `Gutenberg group blocks with matching accent colors.`;
    return out;
  },
};
