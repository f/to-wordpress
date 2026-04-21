import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { MigrationContext } from "../types.js";
import type { UiBus } from "../tui/bus.js";

export interface PrerenderResult {
  ok: boolean;
  renderedDir?: string;
  samples: Array<{ sourceUrl: string; filePath: string; kind: "home" | "blog-index" | "post" | "page" | "archive" | "other" }>;
  message?: string;
}

/**
 * Build the source site (when we can) to produce ground-truth HTML so later
 * phases — especially Theme — can target exact byte-for-byte output.
 *
 * Currently supports Jekyll (via `bundle exec jekyll build`). Returns a list
 * of representative rendered pages the Theme phase should use as reference.
 */
export async function runPrerender(ctx: MigrationContext, bus: UiBus): Promise<PrerenderResult> {
  const detected = ctx.detected;
  if (!detected) return { ok: false, samples: [], message: "no detected context" };

  const renderedDir = join(ctx.workDir, "rendered");
  await mkdir(renderedDir, { recursive: true });

  if (detected.kind === "jekyll") {
    return prerenderJekyll(ctx, bus, renderedDir);
  }
  bus.pushStreamEvent("theme", {
    type: "info",
    phase: "theme",
    message: `no prerender adapter for kind=${detected.kind}; skipping ground-truth build`,
  });
  return { ok: false, samples: [], message: `unsupported kind ${detected.kind}` };
}

async function prerenderJekyll(
  ctx: MigrationContext,
  bus: UiBus,
  renderedDir: string,
): Promise<PrerenderResult> {
  const gemfile = join(ctx.sourceDir, "Gemfile");
  if (!existsSync(gemfile)) {
    return { ok: false, samples: [], message: "no Gemfile" };
  }

  // Try Docker first (self-contained, no Ruby version headaches). Fall back to
  // host `bundle exec jekyll build` only if Docker isn't available.
  const viaDocker = await buildJekyllViaDocker(ctx, bus, renderedDir);
  if (viaDocker) return viaDocker;
  return buildJekyllViaHost(ctx, bus, renderedDir);
}

async function buildJekyllViaDocker(
  ctx: MigrationContext,
  bus: UiBus,
  renderedDir: string,
): Promise<PrerenderResult | undefined> {
  const dockerPing = await execa("docker", ["info"], { reject: false, timeout: 5000 });
  if ((dockerPing.exitCode ?? 1) !== 0) return undefined;

  bus.pushStreamEvent("theme", {
    type: "info",
    phase: "theme",
    message: "prerender: jekyll build via docker (ruby:3.2-slim, fresh Gemfile.lock)",
  });
  // Copy source to a temp working dir inside the container, drop Gemfile.lock
  // (avoids bundler version pins), install fresh, then build into /out.
  const script = [
    "set -e",
    "apt-get update -qq >/dev/null",
    "apt-get install -y --no-install-recommends git build-essential >/dev/null 2>&1",
    "cp -r /src/. /work/",
    "rm -f /work/Gemfile.lock",
    "cd /work",
    "gem install bundler --no-document -q >/dev/null",
    "bundle install --quiet 2>&1 | tail -5",
    "bundle exec jekyll build --destination /out --quiet --trace 2>&1 | tail -10",
  ].join("\n");
  const child = await execa(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${ctx.sourceDir}:/src:ro`,
      "-v",
      `${renderedDir}:/out`,
      "-e",
      "JEKYLL_ENV=production",
      "-w",
      "/work",
      "ruby:3.2-slim",
      "sh",
      "-c",
      script,
    ],
    {
      reject: false,
      timeout: 15 * 60 * 1000,
    },
  );
  if ((child.exitCode ?? 1) !== 0) {
    bus.pushStreamEvent("theme", {
      type: "warn",
      phase: "theme",
      message: `docker jekyll build failed (${child.exitCode}); falling back to host bundle. stderr: ${(child.stderr ?? "").slice(0, 200)}`,
    });
    return undefined;
  }
  const samples = await pickSamples(renderedDir);
  bus.pushStreamEvent("theme", {
    type: "info",
    phase: "theme",
    message: `prerender: docker jekyll built ${samples.length} sample pages`,
  });
  return { ok: true, renderedDir, samples };
}

async function buildJekyllViaHost(
  ctx: MigrationContext,
  bus: UiBus,
  renderedDir: string,
): Promise<PrerenderResult> {
  bus.pushStreamEvent("theme", { type: "info", phase: "theme", message: "prerender: bundle install (host)" });
  try {
    await execa("bundle", ["install", "--path", "vendor/bundle"], {
      cwd: ctx.sourceDir,
      reject: false,
      timeout: 5 * 60 * 1000,
      env: { ...process.env, BUNDLE_SILENCE_ROOT_WARNING: "1" },
    });
  } catch (err) {
    bus.pushStreamEvent("theme", {
      type: "warn",
      phase: "theme",
      message: `bundle install failed: ${(err as Error).message}`,
    });
  }
  const child = await execa(
    "bundle",
    ["exec", "jekyll", "build", "--destination", renderedDir, "--quiet", "--trace"],
    {
      cwd: ctx.sourceDir,
      reject: false,
      timeout: 10 * 60 * 1000,
      env: {
        ...process.env,
        JEKYLL_ENV: "production",
        BUNDLE_SILENCE_ROOT_WARNING: "1",
      },
    },
  );
  if ((child.exitCode ?? 1) !== 0) {
    bus.pushStreamEvent("theme", {
      type: "warn",
      phase: "theme",
      message: `jekyll build failed (${child.exitCode}); theme phase will run without ground-truth HTML`,
    });
    return { ok: false, samples: [], message: `jekyll build exit ${child.exitCode}` };
  }
  const samples = await pickSamples(renderedDir);
  bus.pushStreamEvent("theme", {
    type: "info",
    phase: "theme",
    message: `prerender: host jekyll built ${samples.length} sample pages`,
  });
  return { ok: true, renderedDir, samples };
}

async function pickSamples(renderedDir: string): Promise<PrerenderResult["samples"]> {
  const out: PrerenderResult["samples"] = [];
  const home = join(renderedDir, "index.html");
  if (existsSync(home)) out.push({ sourceUrl: "/", filePath: home, kind: "home" });
  const blogIndex = join(renderedDir, "blog", "index.html");
  if (existsSync(blogIndex)) out.push({ sourceUrl: "/blog/", filePath: blogIndex, kind: "blog-index" });

  const blogDir = join(renderedDir, "blog");
  if (existsSync(blogDir)) {
    const subs = await readdir(blogDir, { withFileTypes: true, encoding: "utf8" }).catch(() => []);
    const sample = subs.find(
      (e) => e.isDirectory() && e.name !== "page" && !e.name.startsWith("."),
    );
    if (sample) {
      const postHtml = join(blogDir, sample.name, "index.html");
      if (existsSync(postHtml)) out.push({ sourceUrl: `/blog/${sample.name}/`, filePath: postHtml, kind: "post" });
    }
  }

  for (const p of ["privacy", "terms", "contact", "about"]) {
    const f = join(renderedDir, p, "index.html");
    if (existsSync(f)) {
      out.push({ sourceUrl: `/${p}/`, filePath: f, kind: "page" });
      break;
    }
  }

  const cat = join(renderedDir, "category");
  if (existsSync(cat)) {
    const subs = await readdir(cat, { withFileTypes: true, encoding: "utf8" }).catch(() => []);
    const sample = subs.find((e) => e.isDirectory());
    if (sample) {
      const html = join(cat, sample.name, "index.html");
      if (existsSync(html)) out.push({ sourceUrl: `/category/${sample.name}/`, filePath: html, kind: "archive" });
    }
  }
  return out;
}

/**
 * Read up to `maxBytes` from a file, preserving UTF-8.
 */
export async function readSample(filePath: string, maxBytes = 8000): Promise<string> {
  const raw = await readFile(filePath, "utf8");
  if (raw.length <= maxBytes) return raw;
  return raw.slice(0, maxBytes) + `\n\n<!-- …truncated at ${maxBytes} of ${raw.length} chars — read the file directly for the rest -->\n`;
}
