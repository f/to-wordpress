import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { MigrationContext, RawSourceFormat } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import { runCopilotPhase } from "./theme.js";

/**
 * Per-format Copilot prompt routing. Keyed by {@link RawSourceFormat}.
 *
 * The matching markdown lives at `src/prompts/convert-<name>.md`. When
 * adding a new source format:
 *   1. Extend the `RawSourceFormat` type in `src/types.ts`.
 *   2. Add a detector that emits it in `DetectedContext.rawSources`.
 *   3. Write `src/prompts/convert-<name>.md`.
 *   4. Register it in the map below.
 */
const FORMAT_PROMPT: Record<RawSourceFormat, string> = {
  docx: "convert-docx",
  xlsx: "convert-xlsx",
  csv: "convert-csv",
  pdf: "convert-pdf",
  epub: "convert-epub",
  txt: "convert-txt",
  html: "convert-html",
  wxr: "convert-wxr",
  "medium-html": "convert-medium-html",
  substack: "convert-substack",
  readme: "convert-readme",
};

/**
 * Whether this format produces ONE markdown file (point-to-file) or
 * potentially MANY (row-per-spreadsheet, item-per-WXR, chapter-per-epub).
 * Point-to-file formats target a specific `{{TARGET_FILE}}`; fan-out
 * formats target a `{{TARGET_DIR}}` and Copilot decides how many
 * markdown files to emit.
 */
const FANOUT: Set<RawSourceFormat> = new Set([
  "xlsx",
  "csv",
  "wxr",
  "epub",
  "substack",
]);

/**
 * Pre-normalize pass. Walks every raw source declared by the detector
 * and invokes Copilot with the matching `convert-<format>.md` prompt
 * to produce canonical markdown inside a scratch directory. The
 * scratch directory is then appended to the detected collections so
 * the regular normalize loop picks up its freshly-written markdown.
 *
 * This is a no-op when the detector didn't emit `rawSources` (all the
 * classic SSGs — Jekyll, Hugo, etc. — already ship markdown).
 */
export async function runConvert(ctx: MigrationContext, bus: UiBus): Promise<void> {
  const detected = ctx.detected;
  if (!detected || !detected.rawSources || detected.rawSources.length === 0) return;
  if (ctx.flags.skipCopilot) {
    bus.pushStreamEvent("normalize", {
      type: "warn",
      phase: "normalize",
      message:
        `raw source conversion requires copilot (${detected.rawSources.length} file(s) ` +
        `of formats: ${[...new Set(detected.rawSources.map((r) => r.format))].join(", ")}). ` +
        `Skipping because --skip-copilot was passed.`,
    });
    return;
  }

  const scratchRoot = join(ctx.workDir, "converted");
  await mkdir(scratchRoot, { recursive: true });
  bus.pushStreamEvent("normalize", {
    type: "info",
    phase: "normalize",
    message: `converting ${detected.rawSources.length} raw source file(s) to markdown`,
  });

  // Group by format so we can batch single-file ones and still give
  // Copilot a per-file call for fan-out formats that emit multiple
  // markdown outputs.
  const byFormat = new Map<RawSourceFormat, typeof detected.rawSources>();
  for (const src of detected.rawSources) {
    if (!FORMAT_PROMPT[src.format]) {
      bus.pushStreamEvent("normalize", {
        type: "warn",
        phase: "normalize",
        message: `no convert prompt registered for format "${src.format}" — skipping ${src.path}`,
      });
      continue;
    }
    const list = byFormat.get(src.format) ?? [];
    list.push(src);
    byFormat.set(src.format, list);
  }

  for (const [format, list] of byFormat) {
    const fanout = FANOUT.has(format);
    const tpl = await loadPrompt(FORMAT_PROMPT[format]);
    for (const src of list!) {
      const slug = slugifyPath(basename(src.path, extname(src.path)));
      const postType = src.postType ?? "post";
      const targetDir = join(scratchRoot, format, postType);
      await mkdir(targetDir, { recursive: true });
      const targetFile = join(targetDir, `${slug}.md`);

      const vars: Record<string, string> = {
        SOURCE_FILE: src.path,
        SOURCE_DIR: detected.sourceDir,
        TARGET_FILE: targetFile,
        TARGET_DIR: targetDir,
        MEDIA_DIR: ctx.mediaDir,
        POST_TYPE: postType,
        HINT: src.hint ?? "",
        DETECTOR_BRIEFING: detected.detectorBriefing ?? "",
      };
      const prompt = interpolate(tpl, vars);

      bus.pushStreamEvent("normalize", {
        type: "info",
        phase: "normalize",
        message: `converting ${basename(src.path)} (${format}) → ${fanout ? targetDir : targetFile}`,
      });

      try {
        const result = await runCopilotPhase(bus, "normalize", {
          prompt,
          cwd: ctx.sourceDir,
          addDirs: [ctx.sourceDir, ctx.workDir, ctx.mediaDir],
          resumeSessionId: ctx.copilotSessionId,
          maxAutopilotContinues: 30,
          timeoutMs: 8 * 60 * 1000,
        });
        if (result.sessionId) ctx.copilotSessionId = result.sessionId;
      } catch (err) {
        bus.pushStreamEvent("normalize", {
          type: "warn",
          phase: "normalize",
          message: `copilot conversion failed for ${basename(src.path)}: ${(err as Error).message}`,
        });
      }

      if (fanout) {
        const produced = await countMarkdown(targetDir);
        if (produced === 0) {
          bus.pushStreamEvent("normalize", {
            type: "warn",
            phase: "normalize",
            message: `copilot produced no markdown under ${targetDir} — falling back to a stub`,
          });
          await writeStub(targetFile, src.path, postType);
        }
      } else if (!existsSync(targetFile)) {
        bus.pushStreamEvent("normalize", {
          type: "warn",
          phase: "normalize",
          message: `copilot did not write ${targetFile} — falling back to a stub`,
        });
        await writeStub(targetFile, src.path, postType);
      }
    }

    // Register scratch outputs. Post-typed outputs become collections;
    // page-typed outputs feed `detected.pages` (the normalize loop
    // iterates pages separately).
    const byPostType = groupByPostType(list!);
    for (const [postType, count] of byPostType) {
      const dir = join(scratchRoot, format, postType);
      if (postType === "page") {
        const files = await listMarkdownFiles(dir);
        const pages = new Set<string>([...(detected.pages ?? []), ...files]);
        detected.pages = [...pages];
      } else {
        const coll = {
          name: postType === "post" ? `${format}-imports` : postType,
          dir,
          permalink: `/${postType === "post" ? "" : postType + "/"}:slug/`,
          count,
        };
        const existing = detected.collections.find((c) => c.dir === coll.dir);
        if (existing) existing.count = coll.count;
        else detected.collections.push(coll);
      }
    }
  }
}

function groupByPostType(sources: RawSourceEntry[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sources) {
    const pt = s.postType ?? "post";
    m.set(pt, (m.get(pt) ?? 0) + 1);
  }
  return m;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = await readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.(md|mdx|markdown)$/i.test(p)) out.push(p);
    }
  }
  return out.sort();
}

function slugifyPath(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "imported";
}

async function countMarkdown(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = await readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.(md|mdx|markdown)$/i.test(p)) n++;
    }
  }
  return n;
}

async function writeStub(target: string, sourcePath: string, postType: string): Promise<void> {
  await mkdir(join(target, ".."), { recursive: true });
  const slug = slugifyPath(basename(sourcePath, extname(sourcePath)));
  const title = basename(sourcePath, extname(sourcePath)).replace(/[-_]+/g, " ");
  const fm = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `slug: ${slug}`,
    `date: ${new Date().toISOString()}`,
    `status: draft`,
    `post_type: ${postType}`,
    `source_path: ${JSON.stringify(sourcePath)}`,
    "---",
    "",
    "_This item could not be converted automatically. Please edit to add the real body._",
    "",
  ].join("\n");
  await writeFile(target, fm, "utf8");
}

/**
 * Build the extra `collections[]` entries that point the normalize
 * phase at the scratch dir. For point-to-file formats all outputs
 * share one target dir per post type.
 */
interface RawSourceEntry {
  path: string;
  format: RawSourceFormat;
  hint?: string;
  postType?: string;
}
