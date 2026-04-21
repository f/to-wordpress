import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Detector } from "./types.js";
import { baseContext, walkAll } from "./common.js";

/**
 * MkDocs detector — `mkdocs.yml` + `docs/` directory. Pure markdown
 * docs site, often with the Material for MkDocs theme.
 */
export const mkdocsDetector: Detector = {
  name: "mkdocs",
  priority: 68,

  async match(dir) {
    const hasConfig = existsSync(join(dir, "mkdocs.yml")) || existsSync(join(dir, "mkdocs.yaml"));
    const hasDocs = existsSync(join(dir, "docs"));
    if (hasConfig && hasDocs) return 0.95;
    if (hasConfig) return 0.7;
    return 0;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "mkdocs";

    try {
      const cfgPath = existsSync(join(dir, "mkdocs.yml"))
        ? join(dir, "mkdocs.yml")
        : join(dir, "mkdocs.yaml");
      if (existsSync(cfgPath)) {
        const cfg = parseYaml(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
        out.siteTitle = (cfg.site_name as string) ?? out.siteTitle;
        out.domain = (cfg.site_url as string) ?? out.domain;
      }
    } catch {
      /* ignore */
    }

    const docsDir = join(dir, "docs");
    if (existsSync(docsDir)) {
      const files = (await walkAll(docsDir, 6)).filter((f) => /\.(md|mdx)$/i.test(f));
      out.collections.push({
        name: "docs",
        dir: docsDir,
        permalink: "/docs/:slug/",
        count: files.length,
      });
    }

    out.assetsDirs = ["docs/assets", "docs/img", "docs/images", "docs/stylesheets"]
      .map((p) => join(dir, p))
      .filter((p) => existsSync(p));
    out.detectorBriefing =
      `Source is an MkDocs (often Material) documentation site. The mkdocs.yml nav ` +
      `defines the sidebar — if present, mirror it in the WordPress "docs" menu in ` +
      `the order declared. Admonitions ("!!! note") and content tabs ("=== \\"Tab\\"") ` +
      `must be translated to Gutenberg group / tabs blocks.`;
    return out;
  },
};
