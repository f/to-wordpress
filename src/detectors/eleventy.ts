import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, listFiles, readCname, readPackageJson } from "./common.js";

const CONFIGS = [
  ".eleventy.js",
  ".eleventy.cjs",
  ".eleventy.mjs",
  "eleventy.config.js",
  "eleventy.config.cjs",
  "eleventy.config.mjs",
];

export const eleventyDetector: Detector = {
  name: "eleventy",
  priority: 90,

  async match(dir) {
    const hasConfig = CONFIGS.some((f) => existsSync(join(dir, f)));
    const pkg = await readPackageJson(dir);
    const has11tyDep = !!(
      pkg?.devDependencies && typeof pkg.devDependencies === "object" && ("@11ty/eleventy" in (pkg.devDependencies as object))
    ) || !!(
      pkg?.dependencies && typeof pkg.dependencies === "object" && ("@11ty/eleventy" in (pkg.dependencies as object))
    );
    if (!hasConfig && !has11tyDep) return 0;
    let score = 0.45;
    if (hasConfig) score += 0.2;
    if (has11tyDep) score += 0.2;
    if (existsSync(join(dir, "src")) || existsSync(join(dir, "content"))) score += 0.15;
    return Math.min(1, score);
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "eleventy";
    const pkg = await readPackageJson(dir);
    out.siteTitle = (pkg?.name as string | undefined) ?? undefined;
    out.domain = (pkg?.homepage as string | undefined) ?? (await readCname(dir));

    const candidates = ["src", "content", "posts", "_posts"];
    for (const name of candidates) {
      const p = join(dir, name);
      if (!existsSync(p)) continue;
      const mds = await listFiles(p, ".md");
      if (mds.length > 0) {
        if (name === "posts" || name === "_posts") {
          out.collections.push({ name: "posts", dir: p, permalink: "/:slug/", count: mds.length });
        } else {
          const postsDir = join(p, "posts");
          if (existsSync(postsDir)) {
            const postMds = await listFiles(postsDir, ".md");
            out.collections.push({ name: "posts", dir: postsDir, permalink: "/posts/:slug/", count: postMds.length });
            out.pages = mds.filter((f) => !f.startsWith(postsDir));
          } else {
            out.pages = mds;
          }
        }
      }
      const layouts = await listFiles(p, ".njk");
      const liquid = await listFiles(p, ".liquid");
      const hbs = await listFiles(p, ".hbs");
      out.layouts.push(...layouts, ...liquid, ...hbs);
    }
    const includesCandidates = ["_includes", "src/_includes"];
    for (const name of includesCandidates) {
      if (existsSync(join(dir, name))) {
        out.includes.push(...(await listFiles(join(dir, name))));
      }
    }
    if (existsSync(join(dir, "_data"))) out.dataFiles = await listFiles(join(dir, "_data"));
    if (existsSync(join(dir, "src/_data"))) out.dataFiles.push(...(await listFiles(join(dir, "src/_data"))));

    return out;
  },
};
