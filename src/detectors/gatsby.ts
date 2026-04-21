import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, listFiles, readCname, readPackageJson } from "./common.js";

export const gatsbyDetector: Detector = {
  name: "gatsby",
  priority: 85,

  async match(dir) {
    const hasConfig =
      existsSync(join(dir, "gatsby-config.js")) ||
      existsSync(join(dir, "gatsby-config.ts")) ||
      existsSync(join(dir, "gatsby-config.mjs"));
    const pkg = await readPackageJson(dir);
    const hasGatsby = !!(
      pkg?.dependencies && typeof pkg.dependencies === "object" && ("gatsby" in (pkg.dependencies as object))
    );
    if (!hasConfig && !hasGatsby) return 0;
    let score = 0.5;
    if (hasConfig) score += 0.2;
    if (hasGatsby) score += 0.2;
    if (existsSync(join(dir, "src/pages")) || existsSync(join(dir, "content"))) score += 0.1;
    return Math.min(1, score);
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "gatsby";
    const pkg = await readPackageJson(dir);
    out.siteTitle = (pkg?.name as string | undefined) ?? undefined;
    out.domain = (pkg?.homepage as string | undefined) ?? (await readCname(dir));

    const tsxPages = await listFiles(join(dir, "src/pages"), ".tsx");
    const jsPages = await listFiles(join(dir, "src/pages"), ".jsx");
    out.layouts = [...tsxPages, ...jsPages];

    const content = await listFiles(join(dir, "content"), ".md");
    const mdx = await listFiles(join(dir, "content"), ".mdx");
    const all = [...content, ...mdx];
    if (all.length > 0) {
      out.collections.push({
        name: "posts",
        dir: join(dir, "content"),
        permalink: "/:slug/",
        count: all.length,
      });
    }

    return out;
  },
};
