import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, listFiles, readCname, readPackageJson } from "./common.js";

export const nextDetector: Detector = {
  name: "next",
  priority: 80,

  async match(dir) {
    const hasConfig =
      existsSync(join(dir, "next.config.js")) ||
      existsSync(join(dir, "next.config.ts")) ||
      existsSync(join(dir, "next.config.mjs"));
    const pkg = await readPackageJson(dir);
    const hasNext = !!(
      pkg?.dependencies && typeof pkg.dependencies === "object" && ("next" in (pkg.dependencies as object))
    );
    if (!hasConfig && !hasNext) return 0;
    let score = 0.45;
    if (hasConfig) score += 0.2;
    if (hasNext) score += 0.2;
    if (existsSync(join(dir, "app")) || existsSync(join(dir, "pages"))) score += 0.1;
    return Math.min(1, score);
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "next";
    const pkg = await readPackageJson(dir);
    out.siteTitle = (pkg?.name as string | undefined) ?? undefined;
    out.domain = (pkg?.homepage as string | undefined) ?? (await readCname(dir));

    for (const root of ["app", "src/app", "pages", "src/pages"]) {
      const p = join(dir, root);
      if (!existsSync(p)) continue;
      const tsx = await listFiles(p, ".tsx");
      const jsx = await listFiles(p, ".jsx");
      out.layouts.push(...tsx, ...jsx);
    }

    for (const name of ["content", "posts", "_posts", "blog"]) {
      const p = join(dir, name);
      if (!existsSync(p)) continue;
      const md = await listFiles(p, ".md");
      const mdx = await listFiles(p, ".mdx");
      const all = [...md, ...mdx];
      if (all.length > 0) {
        out.collections.push({
          name: name === "_posts" ? "posts" : name,
          dir: p,
          permalink: name === "blog" || name === "posts" || name === "_posts" ? "/blog/:slug/" : `/${name}/:slug/`,
          count: all.length,
        });
      }
    }

    return out;
  },
};
