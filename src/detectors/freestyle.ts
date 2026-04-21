import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import matter from "gray-matter";
import type { DetectedContext, MigrationContext } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import type { Detector } from "./types.js";
import { baseContext, listFiles, readCname, walkAll } from "./common.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import { runCopilot } from "../copilot/run.js";

/**
 * Freestyle detector — always succeeds. When none of the built-in SSG
 * detectors matched, we:
 *   1. Do a deterministic best-effort inventory so we NEVER return empty.
 *   2. If copilot is enabled, ask it to enrich/correct the inventory
 *      (reading files, discovering custom conventions, etc.). Copilot
 *      writes a `detected.json` we merge on top.
 *
 * The goal is: "never skip any folder, always try to migrate."
 */
export const freestyleDetector: Detector = {
  name: "unknown",
  priority: 0,

  async match() {
    return 0.01;
  },

  async detect(ctx, bus) {
    bus.pushStreamEvent("detect", {
      type: "info",
      phase: "detect",
      message: "freestyle detection — no known SSG matched; inventorying every folder",
    });

    const deterministic = await deterministicInventory(ctx.sourceDir);
    if (ctx.flags.skipCopilot) {
      bus.pushStreamEvent("detect", {
        type: "info",
        phase: "detect",
        message: "copilot skipped; using deterministic freestyle inventory only",
      });
      return deterministic;
    }

    const enriched = await copilotFreestyle(ctx, bus, deterministic);
    return enriched ?? deterministic;
  },
};

async function deterministicInventory(dir: string): Promise<DetectedContext> {
  const out = baseContext(dir);
  out.kind = "unknown";
  out.domain = await readCname(dir);

  const files = await walkAll(dir, 10);

  const templates = files.filter((f) => /\.(html?|njk|liquid|hbs|ejs|pug)$/i.test(f));
  const markdown = files.filter((f) => /\.(md|markdown|mdx)$/i.test(f));
  const sass = files.filter((f) => /\.s[ac]ss$/i.test(f));

  out.layouts = templates;
  out.sassFiles = sass;

  const includesDirs = new Set<string>();
  for (const f of templates) {
    const rel = relative(dir, f);
    if (/^(_includes|partials|components|_partials|shared)\//.test(rel)) {
      includesDirs.add(dir + "/" + rel.split("/")[0]);
    }
  }
  out.includes = templates.filter((f) => [...includesDirs].some((i) => f.startsWith(i + "/")));

  const assetHints = ["assets", "static", "public", "images", "img", "media", "css", "js", "fonts"];
  const assets = new Set<string>();
  for (const f of files) {
    const rel = relative(dir, f);
    const root = rel.split("/")[0];
    if (assetHints.includes(root)) assets.add(join(dir, root));
  }
  out.assetsDirs = [...assets];

  const byDir = new Map<string, string[]>();
  for (const f of markdown) {
    const d = dirname(f);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d)!.push(f);
  }

  const topLevelMdDirs: Array<{ dir: string; files: string[] }> = [];
  for (const [d, fs] of byDir) {
    if (fs.length >= 3) topLevelMdDirs.push({ dir: d, files: fs });
  }
  topLevelMdDirs.sort((a, b) => b.files.length - a.files.length);

  if (topLevelMdDirs.length > 0) {
    for (let i = 0; i < topLevelMdDirs.length; i++) {
      const entry = topLevelMdDirs[i];
      const rel = relative(dir, entry.dir);
      const name = inferCollectionName(rel) || (i === 0 ? "posts" : `collection-${i + 1}`);
      out.collections.push({
        name,
        dir: entry.dir,
        permalink: name === "posts" ? "/:slug/" : `/${name}/:slug/`,
        count: entry.files.length,
      });
    }
  }

  const collectionFiles = new Set<string>(out.collections.flatMap((c) => byDir.get(c.dir) ?? []));
  out.pages = markdown.filter((f) => !collectionFiles.has(f));

  const fmKeys = new Set<string>();
  const sample = markdown.slice(0, 20);
  for (const f of sample) {
    try {
      const raw = await readFile(f, "utf8");
      const parsed = matter(raw);
      for (const k of Object.keys(parsed.data)) fmKeys.add(k);
    } catch {
      /* ignore */
    }
  }
  out.frontMatterKeys = [...fmKeys].sort();

  return out;
}

function inferCollectionName(relDir: string): string | undefined {
  const first = relDir.split("/").filter((s) => s && !s.startsWith("_")).join("-");
  if (!first) return undefined;
  if (relDir.includes("_posts") || /posts?$/.test(relDir)) return "posts";
  if (/blog/.test(relDir)) return "posts";
  return first.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

async function copilotFreestyle(
  ctx: MigrationContext,
  bus: UiBus,
  seed: DetectedContext,
): Promise<DetectedContext | undefined> {
  await mkdir(ctx.workDir, { recursive: true });
  const outputPath = join(ctx.workDir, "detected.json");
  const tpl = await loadPrompt("detect-freestyle");
  const prompt = interpolate(tpl, {
    SOURCE_DIR: ctx.sourceDir,
    SEED_JSON: JSON.stringify(compactSeed(seed), null, 2),
    OUTPUT_PATH: outputPath,
  });

  bus.pushStreamEvent("detect", {
    type: "info",
    phase: "detect",
    message: "invoking copilot to freestyle-detect the source",
  });

  try {
    const iter = runCopilot({
      prompt,
      cwd: ctx.sourceDir,
      addDirs: [ctx.sourceDir, ctx.workDir],
      mode: "autopilot",
      maxAutopilotContinues: 40,
      timeoutMs: 10 * 60 * 1000,
    });
    let sessionId: string | undefined;
    while (true) {
      const next = await iter.next();
      if (next.done) {
        sessionId = next.value.sessionId ?? sessionId;
        break;
      }
      bus.pushStreamEvent("detect", next.value);
      if (next.value.type === "session") sessionId = next.value.sessionId;
    }
    if (sessionId) ctx.copilotSessionId = sessionId;
  } catch (err) {
    bus.pushStreamEvent("detect", {
      type: "warn",
      phase: "detect",
      message: `freestyle copilot failed: ${(err as Error).message}`,
    });
    return undefined;
  }

  if (!existsSync(outputPath)) {
    bus.pushStreamEvent("detect", {
      type: "warn",
      phase: "detect",
      message: "copilot did not write detected.json; keeping deterministic inventory",
    });
    return undefined;
  }
  try {
    const raw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DetectedContext>;
    return mergeContext(seed, parsed);
  } catch (err) {
    bus.pushStreamEvent("detect", {
      type: "warn",
      phase: "detect",
      message: `failed to parse copilot detected.json: ${(err as Error).message}`,
    });
    return undefined;
  }
}

function compactSeed(seed: DetectedContext): Record<string, unknown> {
  const cap = (arr: string[], n: number) =>
    arr.length > n ? [...arr.slice(0, n), `…(+${arr.length - n} more)`] : arr;
  return {
    kind: seed.kind,
    domain: seed.domain,
    layouts: cap(seed.layouts, 60),
    includes: cap(seed.includes, 40),
    sassFiles: cap(seed.sassFiles, 20),
    assetsDirs: seed.assetsDirs,
    dataFiles: cap(seed.dataFiles, 20),
    collections: seed.collections,
    pages: cap(seed.pages, 40),
    frontMatterKeys: seed.frontMatterKeys,
  };
}

function mergeContext(seed: DetectedContext, patch: Partial<DetectedContext>): DetectedContext {
  return {
    ...seed,
    ...patch,
    sourceDir: seed.sourceDir,
    themeSlug: patch.themeSlug ?? seed.themeSlug,
    pluginSlug: patch.pluginSlug ?? seed.pluginSlug,
    layouts: (patch.layouts && patch.layouts.length > 0 ? patch.layouts : seed.layouts) ?? [],
    includes: patch.includes ?? seed.includes,
    sassFiles: patch.sassFiles ?? seed.sassFiles,
    assetsDirs: patch.assetsDirs ?? seed.assetsDirs,
    dataFiles: patch.dataFiles ?? seed.dataFiles,
    ssgPlugins: patch.ssgPlugins ?? seed.ssgPlugins,
    collections:
      patch.collections && patch.collections.length > 0 ? patch.collections : seed.collections,
    pages: patch.pages ?? seed.pages,
    frontMatterKeys: patch.frontMatterKeys ?? seed.frontMatterKeys,
    features: { ...seed.features, ...(patch.features ?? {}) },
    colors: patch.colors ?? seed.colors,
    fonts: patch.fonts ?? seed.fonts,
  };
}
