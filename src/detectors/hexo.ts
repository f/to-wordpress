import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Detector } from "./types.js";
import { baseContext, readPackageJson, walkAll } from "./common.js";

/**
 * Hexo detector — the `_config.yml` + `source/_posts/` convention used
 * by the Node-based Hexo SSG. Treated like Jekyll but with a different
 * folder layout and front-matter dialect.
 */
export const hexoDetector: Detector = {
  name: "hexo",
  priority: 60,

  async match(dir) {
    const pkg = await readPackageJson(dir);
    const depends = (pkg?.dependencies ?? {}) as Record<string, string>;
    const devDepends = (pkg?.devDependencies ?? {}) as Record<string, string>;
    const hasHexoDep = Boolean(depends.hexo || devDepends.hexo);
    const hasHexoConfig =
      existsSync(join(dir, "_config.yml")) && existsSync(join(dir, "source", "_posts"));
    if (hasHexoDep && hasHexoConfig) return 0.97;
    if (hasHexoConfig) return 0.85;
    if (hasHexoDep) return 0.55;
    return 0;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "hexo";

    try {
      const cfgPath = join(dir, "_config.yml");
      if (existsSync(cfgPath)) {
        const parsed = parseYaml(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
        out.siteTitle = (parsed?.title as string) ?? out.siteTitle;
        out.domain = (parsed?.url as string) ?? out.domain;
        const permalink = (parsed?.permalink as string) ?? ":year/:month/:day/:title/";
        const posts = join(dir, "source", "_posts");
        if (existsSync(posts)) {
          const files = (await walkAll(posts, 4)).filter((f) => /\.(md|mdx|markdown)$/i.test(f));
          out.collections.push({
            name: "posts",
            dir: posts,
            permalink: "/" + permalink.replace(/:title/g, ":slug").replace(/^\/+/, ""),
            count: files.length,
          });
        }
      }
    } catch {
      /* keep deterministic defaults */
    }

    const pagesDir = join(dir, "source");
    if (existsSync(pagesDir)) {
      const all = await walkAll(pagesDir, 4);
      const md = all.filter((f) => /\.(md|markdown|mdx)$/i.test(f));
      const posts = new Set<string>(out.collections.flatMap((c) => c.dir));
      out.pages = md.filter((f) => !posts.has(f));
    }
    out.assetsDirs = ["source/images", "source/assets", "source/img"]
      .map((p) => join(dir, p))
      .filter((p) => existsSync(p));
    out.detectorBriefing =
      `Source is a Hexo blog. Preserve permalink structure (${relative(dir, join(dir, "_config.yml"))}). ` +
      `Hexo front-matter uses "categories" and "tags" as nested YAML arrays. ` +
      `The "more" tag (<!-- more -->) marks the excerpt cutoff — keep as excerpt.`;
    return out;
  },
};
