import { existsSync } from "node:fs";
import { join, basename, relative } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, readCname, walkAll } from "./common.js";

/**
 * GitHub repository / README-driven landing page detector.
 *
 * Triggers on a directory that looks like a code repo (`.git`, a
 * `package.json` / `Cargo.toml` / `pyproject.toml`, a root README) but
 * without any SSG config. The output is a one-page WordPress site
 * that uses the README as the hero-and-features landing page, plus a
 * `docs/` collection (if present) for deeper reading.
 *
 * The `convert-readme.md` prompt turns the top README into a structured
 * landing page: hero section, feature grid, install CTA, badges → trust
 * strip, code fences → pretty syntax-highlighted blocks.
 */
export const githubRepoDetector: Detector = {
  name: "github-repo",
  priority: 22,

  async match(dir) {
    const files = await walkAll(dir, 3);
    const hasReadme = files.some((f) => /\/README\.(md|mdx|rst|txt)$/i.test(f));
    if (!hasReadme) return 0;
    const isRepo =
      existsSync(join(dir, ".git")) ||
      existsSync(join(dir, "package.json")) ||
      existsSync(join(dir, "Cargo.toml")) ||
      existsSync(join(dir, "pyproject.toml")) ||
      existsSync(join(dir, "go.mod")) ||
      existsSync(join(dir, "Gemfile"));
    if (!isRepo) return 0;
    // If this is actually a concrete SSG (jekyll/hugo/etc.) let the
    // SSG detector win. We only want true "repo with README" cases.
    const hasSsgMarkers = files.some((f) =>
      /\/(_config\.(yml|toml)|hugo\.(toml|yaml)|gatsby-config\.(js|ts)|astro\.config\.(mjs|ts)|docusaurus\.config\.(js|ts)|mkdocs\.yml|\.eleventy\.js)$/i.test(
        f,
      ),
    );
    if (hasSsgMarkers) return 0;
    return existsSync(join(dir, ".git")) ? 0.8 : 0.55;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "github-repo";
    out.siteTitle = basename(dir);
    out.domain = await readCname(dir);

    const files = await walkAll(dir, 6);
    const readme = files.find((f) => /\/README\.(md|mdx|rst|txt)$/i.test(f));
    const license = files.find((f) => /\/LICENSE(\.(md|txt))?$/i.test(f));
    const changelog = files.find((f) => /\/CHANGELOG\.(md|mdx)$/i.test(f));
    const contributing = files.find((f) => /\/CONTRIBUTING\.(md|mdx)$/i.test(f));
    const codeOfConduct = files.find((f) => /\/CODE_OF_CONDUCT\.(md|mdx)$/i.test(f));
    const docsFiles = files.filter(
      (f) => /\/(docs|documentation)\/.+\.(md|mdx)$/i.test(f) && f !== readme,
    );

    // Raw-source routing: README uses the landing-page prompt; the other
    // boilerplate top-level docs use the generic README prompt too so
    // they come out as well-formatted pages instead of raw markdown.
    const rawSources: NonNullable<typeof out.rawSources> = [];
    if (readme) rawSources.push({ path: readme, format: "readme", postType: "page", hint: "landing" });
    if (license) rawSources.push({ path: license, format: "readme", postType: "page", hint: "license" });
    if (changelog) rawSources.push({ path: changelog, format: "readme", postType: "page", hint: "changelog" });
    if (contributing) rawSources.push({ path: contributing, format: "readme", postType: "page", hint: "contributing" });
    if (codeOfConduct) rawSources.push({ path: codeOfConduct, format: "readme", postType: "page", hint: "code-of-conduct" });
    out.rawSources = rawSources;
    out.pages = [];

    if (docsFiles.length > 0) {
      out.collections.push({
        name: "docs",
        dir: join(dir, "docs"),
        permalink: "/docs/:slug/",
        count: docsFiles.length,
      });
    }

    // The README *is* the home page — always put a single `posts`
    // collection in play (empty) so the WordPress site has the usual
    // blog scaffolding available even on pure-landing-page projects.
    if (out.collections.length === 0) {
      out.collections.push({ name: "docs", dir, permalink: "/docs/:slug/", count: 0 });
    }

    const repoKind = inferStack(dir);
    out.detectorBriefing =
      `Source is a ${repoKind} code repository. Produce a SaaS-style landing page ` +
      `from README.md: hero (project name + tagline), feature grid from the bullet ` +
      `list that follows the tagline, "install/use" CTA with the first code fence, ` +
      `social-proof strip from badges, FAQ from later H2 sections. ` +
      (docsFiles.length > 0
        ? `Also migrate ${docsFiles.length} file(s) under docs/ as a Documentation collection.`
        : `No docs/ folder was found — the landing page stands alone.`);

    // Track repo root so Copilot can quote real file paths in the
    // landing page (e.g. GitHub link, install instructions).
    if (docsFiles.length > 0) {
      out.dataFiles = docsFiles.map((f) => relative(dir, f)).slice(0, 50);
    }
    return out;
  },
};

function inferStack(dir: string): string {
  if (existsSync(join(dir, "package.json"))) return "JavaScript/TypeScript";
  if (existsSync(join(dir, "Cargo.toml"))) return "Rust";
  if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "setup.py"))) return "Python";
  if (existsSync(join(dir, "go.mod"))) return "Go";
  if (existsSync(join(dir, "Gemfile"))) return "Ruby";
  if (existsSync(join(dir, "pom.xml")) || existsSync(join(dir, "build.gradle"))) return "JVM";
  return "generic";
}
