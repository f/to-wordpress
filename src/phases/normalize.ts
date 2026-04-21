import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import matter from "gray-matter";
import { stringify as yamlStringify } from "yaml";
import type { MigrationContext, UserChoices, DetectedContext } from "../types.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import { runCopilotPhase } from "./theme.js";
import type { UiBus } from "../tui/bus.js";

export interface NormalizedRef {
  postType: string;
  slug: string;
  path: string;
  originalPermalink: string;
  sourcePath: string;
}

export interface NormalizeResult {
  items: NormalizedRef[];
  mediaCopied: string[];
  failures: Array<{ sourcePath: string; targetPath: string; error: string }>;
}

export async function runNormalize(ctx: MigrationContext, bus: UiBus): Promise<NormalizeResult> {
  bus.pushStreamEvent("normalize", { type: "phase_start", phase: "normalize", message: "measuring the meter — polishing every verse to the same line-length" });
  const detected = ctx.detected;
  const choices = ctx.choices;
  if (!detected || !choices) throw new Error("plan phase must run before normalize");

  await mkdir(ctx.contentDir, { recursive: true });
  await mkdir(ctx.mediaDir, { recursive: true });

  const items: NormalizedRef[] = [];
  const mediaCopied = new Set<string>();
  const failures: NormalizeResult["failures"] = [];

  for (const coll of detected.collections) {
    const postType = resolvePostType(coll.name, choices);
    const files = await listMdFiles(coll.dir);
    for (const src of files) {
      try {
        const ref = await normalizeOne(src, postType, coll.permalink ?? "/:slug/", ctx, detected, mediaCopied);
        items.push(ref);
      } catch (err) {
        failures.push({ sourcePath: src, targetPath: "", error: (err as Error).message });
      }
    }
  }
  for (const src of detected.pages) {
    try {
      const ref = await normalizeOne(src, "page", "/:basename/", ctx, detected, mediaCopied);
      items.push(ref);
    } catch (err) {
      failures.push({ sourcePath: src, targetPath: "", error: (err as Error).message });
    }
  }

  bus.pushStreamEvent("normalize", {
    type: "info",
    phase: "normalize",
    message: `normalized ${items.length} items, ${mediaCopied.size} media, ${failures.length} failures`,
  });

  if (failures.length > 0) {
    bus.pushStreamEvent("normalize", {
      type: "info",
      phase: "normalize",
      message: `invoking copilot on ${failures.length} edge case${failures.length === 1 ? "" : "s"}`,
    });
    const tpl = await loadPrompt("normalize-edge");
    for (const f of failures) {
      const rel = relative(detected.sourceDir, f.sourcePath).replace(/\.(md|markdown|mdx)$/i, "");
      const targetPath = join(ctx.contentDir, "post", slugify(basename(rel)) + ".md");
      f.targetPath = targetPath;
      const prompt = interpolate(tpl, {
        SOURCE_FILE: f.sourcePath,
        TARGET_FILE: targetPath,
        POST_TYPE: "post",
      });
      const result = await runCopilotPhase(bus, "normalize", {
        prompt,
        cwd: ctx.sourceDir,
        addDirs: [ctx.sourceDir, ctx.workDir],
        resumeSessionId: ctx.copilotSessionId,
        maxAutopilotContinues: 20,
        timeoutMs: 5 * 60 * 1000,
      });
      if (result.sessionId) ctx.copilotSessionId = result.sessionId;
      if (existsSync(targetPath)) {
        items.push({
          postType: "post",
          slug: slugify(basename(rel)),
          path: targetPath,
          originalPermalink: "/blog/" + slugify(basename(rel)) + "/",
          sourcePath: f.sourcePath,
        });
      }
    }
  }

  await writeFile(
    join(ctx.contentDir, "index.json"),
    JSON.stringify({ items, failures }, null, 2) + "\n",
    "utf8",
  );

  // Write the discovered-shortcode manifest so the Plugin phase can
  // register PHP handlers for every Liquid include the content used.
  const discoveredShortcodes = Array.from(ctx.shortcodes ?? []).sort();
  await writeFile(
    join(ctx.workDir, "shortcodes.json"),
    JSON.stringify({ shortcodes: discoveredShortcodes }, null, 2) + "\n",
    "utf8",
  );
  if (discoveredShortcodes.length > 0) {
    bus.pushStreamEvent("normalize", {
      type: "info",
      phase: "normalize",
      message: `detected ${discoveredShortcodes.length} custom shortcode(s): ${discoveredShortcodes.join(", ")}`,
    });
  }

  bus.pushStreamEvent("normalize", { type: "phase_ok", phase: "normalize" });
  return { items, mediaCopied: [...mediaCopied], failures };
}

async function normalizeOne(
  srcPath: string,
  postType: string,
  permalinkTpl: string,
  ctx: MigrationContext,
  detected: DetectedContext,
  mediaCopied: Set<string>,
): Promise<NormalizedRef> {
  const raw = await readFile(srcPath, "utf8");
  const parsed = matter(raw);
  const filename = basename(srcPath, extname(srcPath));
  const { date, slug } = extractDateAndSlug(filename, parsed.data);
  const title = (parsed.data.title as string | undefined) ?? humanize(slug);
  const categories = toStringArray(parsed.data.categories ?? parsed.data.category);
  const tags = toStringArray(parsed.data.tags ?? parsed.data.tag);
  const originalPermalink = buildPermalink(permalinkTpl, { slug, date, basename: filename, category: categories[0] });
  const featured = (parsed.data.image as string | undefined) ?? (parsed.data.featured_image as string | undefined);

  let body = parsed.content;
  // Translate Liquid `{% include ... %}` shortcodes (Jekyll "chirpy" and
  // Bootstrap-style themes use these for figure/video/button/alert blocks)
  // into Gutenberg blocks or WordPress shortcodes BEFORE media rewriting,
  // so the `src=` URL inside a figure include still gets its asset copied.
  body = translateLiquidIncludes(body, ctx);
  const { body: body2, copied } = await rewriteMedia(body, srcPath, detected, ctx);
  for (const c of copied) mediaCopied.add(c);
  body = body2;

  for (const key of ["featured_image", "image", "thumbnail", "meta_image"] as const) {
    const ref = parsed.data[key];
    if (typeof ref === "string" && ref.length > 0) {
      const copiedPath = await copyMediaRef(ref, srcPath, detected, ctx);
      if (copiedPath) mediaCopied.add(copiedPath);
    }
  }

  const layout = (parsed.data.layout as string | undefined) ?? undefined;
  const description = (parsed.data.description as string | undefined) ?? undefined;
  const normalized = {
    title,
    slug,
    date,
    updated: (parsed.data.updated as string | undefined) ?? undefined,
    author: (parsed.data.author as string | undefined) ?? undefined,
    status: deriveStatus(parsed.data, srcPath),
    excerpt: (parsed.data.excerpt as string | undefined) ?? description,
    categories,
    tags,
    featured_image: featured,
    post_type: postType,
    original_permalink: originalPermalink,
    source_path: resolve(srcPath),
    layout,
  };

  const targetDir = join(ctx.contentDir, postType);
  await mkdir(targetDir, { recursive: true });
  const targetPath = join(targetDir, `${slug}.md`);
  await writeFile(targetPath, `---\n${yamlStringify(normalized)}---\n\n${body.trim()}\n`, "utf8");

  return {
    postType,
    slug,
    path: targetPath,
    originalPermalink,
    sourcePath: resolve(srcPath),
  };
}

const MEDIA_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Copy a single media reference (as found in a front-matter field like
 * `featured_image` or `image`) from the source tree into the media dir.
 * Returns the absolute path of the copied file, or undefined if the
 * reference could not be resolved.
 */
async function copyMediaRef(
  ref: string,
  srcPath: string,
  detected: DetectedContext,
  ctx: MigrationContext,
): Promise<string | undefined> {
  if (/^https?:\/\//i.test(ref) || ref.startsWith("data:")) return undefined;
  const abs = resolveRef(ref, srcPath, detected.sourceDir);
  if (!abs || !existsSync(abs)) return undefined;
  const rel = relative(detected.sourceDir, abs).replaceAll("\\", "/");
  const flat = rel.replace(/\//g, "__");
  const target = join(ctx.mediaDir, flat);
  if (!existsSync(target)) await copyFile(abs, target);
  return target;
}

async function rewriteMedia(
  body: string,
  srcPath: string,
  detected: DetectedContext,
  ctx: MigrationContext,
): Promise<{ body: string; copied: string[] }> {
  const copied: string[] = [];
  const out = await replaceAsync(body, MEDIA_RE, async (whole, alt: string, url: string) => {
    if (/^https?:\/\//i.test(url) || url.startsWith("data:")) return whole;
    const abs = resolveRef(url, srcPath, detected.sourceDir);
    if (!abs || !existsSync(abs)) return whole;
    const rel = relative(detected.sourceDir, abs).replaceAll("\\", "/");
    const flat = rel.replace(/\//g, "__");
    const target = join(ctx.mediaDir, flat);
    if (!existsSync(target)) await copyFile(abs, target);
    copied.push(target);
    return `![${alt}](media:${flat})`;
  });
  return { body: out, copied };
}

function resolveRef(url: string, srcPath: string, sourceRoot: string): string | undefined {
  if (url.startsWith("/")) return join(sourceRoot, url);
  return resolve(dirname(srcPath), url);
}

async function replaceAsync(
  s: string,
  re: RegExp,
  repl: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const matches: Array<{ match: RegExpExecArray; replacement: string }> = [];
  for (const m of s.matchAll(re)) {
    const replacement = await repl(m[0], ...m.slice(1));
    matches.push({ match: m as RegExpExecArray, replacement });
  }
  let out = "";
  let lastIndex = 0;
  for (const { match, replacement } of matches) {
    out += s.slice(lastIndex, match.index) + replacement;
    lastIndex = match.index + match[0].length;
  }
  out += s.slice(lastIndex);
  return out;
}

function extractDateAndSlug(
  filename: string,
  data: Record<string, unknown>,
): { date: string; slug: string } {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  const date = (data.date as string | undefined) ?? (m ? `${m[1]}T00:00:00Z` : new Date().toISOString());
  const slug = (data.slug as string | undefined) ?? (m ? slugify(m[2]) : slugify(filename));
  return { date: normalizeDate(date), slug };
}

function normalizeDate(d: string): string {
  const t = new Date(d);
  if (isNaN(t.getTime())) return new Date().toISOString();
  return t.toISOString();
}

function buildPermalink(
  tpl: string,
  vars: { slug: string; date: string; basename: string; category?: string },
): string {
  return tpl
    .replace(/:slug/g, vars.slug)
    .replace(/:basename/g, slugify(vars.basename))
    .replace(/:path/g, vars.slug)
    .replace(/:year/g, vars.date.slice(0, 4))
    .replace(/:month/g, vars.date.slice(5, 7))
    .replace(/:day/g, vars.date.slice(8, 10))
    .replace(/:category/g, vars.category ? slugify(vars.category) : "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "/");
}

function resolvePostType(collectionName: string, choices: UserChoices): string {
  if (collectionName === "posts") return "post";
  const cpt = choices.customPostTypes.find((c) => c.name === collectionName);
  return cpt ? cpt.slug : "post";
}

async function listMdFiles(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = await readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.(md|markdown|mdx)$/i.test(p)) out.push(p);
    }
  }
  return out.sort();
}

function toStringArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(/[,;\s]+/).filter(Boolean);
  return [];
}

function humanize(s: string): string {
  return s
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// ─── Liquid shortcode translation ──────────────────────────────────────
//
// Jekyll themes frequently use `{% include path/to/thing.html k="v" ... %}`
// where the included partial is effectively a shortcode (figure, video,
// alert, button, giscus, newsletter, etc.). Copying them verbatim into
// WordPress leaves raw Liquid markup in the rendered post body — the user
// saw this as visible `{% include framework/shortcodes/figure.html …`
// text in their migrated site. We translate every Liquid include:
//
//   - Known media-like shortcodes (figure / video / youtube) render as
//     proper Gutenberg block comments that the WP editor recognizes.
//   - Everything else becomes a WordPress shortcode `[wpify_<name> ... ]`,
//     and the set of shortcode names is persisted so the Plugin phase can
//     register handlers for each one.
//
// The context is shared via ctx's persisted `shortcodes` set written to
// `WORDPRESS_MIGRATION/shortcodes.json` by the normalize phase and read
// back by the plugin phase (see pluginGenerateShortcodes).

const LIQUID_INCLUDE_RE =
  /\{%\s*include(?:_relative)?\s+([^\s%]+)\s*([^%]*?)%\}/g;

function translateLiquidIncludes(body: string, ctx: MigrationContext): string {
  if (!body.includes("{%")) return body;
  ctx.shortcodes ??= new Set<string>();
  return body.replace(LIQUID_INCLUDE_RE, (_whole, path: string, attrsRaw: string) => {
    const name = pathToShortcodeName(path);
    const attrs = parseLiquidAttrs(attrsRaw);
    switch (name) {
      case "figure":
      case "image":
        return renderFigureBlock(attrs);
      case "video":
        return renderVideoBlock(attrs);
      case "youtube":
      case "youtubevideo":
        return renderYouTubeBlock(attrs);
      case "button":
        return renderButtonBlock(attrs);
      case "callout":
      case "alert":
      case "notice":
        return renderCalloutBlock(attrs, name);
      default:
        ctx.shortcodes!.add(name);
        return renderGenericShortcode(name, attrs);
    }
  });
}

function pathToShortcodeName(path: string): string {
  const cleaned = path.replace(/^['"“”‟]+|['"“”‟]+$/g, "");
  const m = cleaned.match(/([^/\\]+)(?:\.html?)?$/);
  const base = (m ? m[1] : cleaned).replace(/\.html?$/i, "");
  return base.replace(/[^\w-]/g, "_").toLowerCase();
}

/**
 * Parse Liquid-style attribute strings, accepting straight quotes, single
 * quotes, curly/smart quotes (copy-paste from fancy Jekyll source often
 * has `src=“/path/foo.webp”`), and bare values.
 */
function parseLiquidAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re =
    /(\w[\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|[\u201C\u201F]([^\u201D\u201F]*)[\u201D\u201F]|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? m[4] ?? m[5] ?? "";
    attrs[key] = val.trim();
  }
  return attrs;
}

function attrEscape(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wpBlock(name: string, inner: string, attrs?: Record<string, unknown>): string {
  const suffix = attrs && Object.keys(attrs).length > 0 ? " " + JSON.stringify(attrs) : "";
  return `\n\n<!-- wp:${name}${suffix} -->\n${inner}\n<!-- /wp:${name} -->\n\n`;
}

function renderFigureBlock(a: Record<string, string>): string {
  const src = a.src ?? a.url ?? a.image ?? "";
  if (!src) return "";
  const alt = attrEscape(a.alt || a.title || a.caption || "");
  const cls = ["wp-block-image", a.class ?? "size-full"].filter(Boolean).join(" ");
  const imgTag = `<img src="${attrEscape(src)}" alt="${alt}"${a.width ? ` width="${attrEscape(a.width)}"` : ""}${a.height ? ` height="${attrEscape(a.height)}"` : ""}/>`;
  const inner = a.link
    ? `<a href="${attrEscape(a.link)}"${a.target ? ` target="${attrEscape(a.target)}" rel="noopener"` : ""}>${imgTag}</a>`
    : imgTag;
  const caption = a.caption
    ? `<figcaption class="wp-element-caption">${attrEscape(a.caption)}</figcaption>`
    : "";
  return wpBlock("image", `<figure class="${cls}">${inner}${caption}</figure>`);
}

function renderVideoBlock(a: Record<string, string>): string {
  const src = a.src ?? a.url ?? "";
  if (!src) return "";
  const poster = a.poster ? ` poster="${attrEscape(a.poster)}"` : "";
  const controls = a.controls === "false" ? "" : " controls";
  return wpBlock(
    "video",
    `<figure class="wp-block-video"><video${controls}${poster} src="${attrEscape(src)}"></video>${a.caption ? `<figcaption class="wp-element-caption">${attrEscape(a.caption)}</figcaption>` : ""}</figure>`,
  );
}

function renderYouTubeBlock(a: Record<string, string>): string {
  const id = a.id ?? a.video ?? a.youtube ?? a.src ?? "";
  if (!id) return "";
  const url = id.startsWith("http") ? id : `https://www.youtube.com/watch?v=${id}`;
  return wpBlock(
    "embed",
    `<figure class="wp-block-embed is-type-video is-provider-youtube wp-block-embed-youtube"><div class="wp-block-embed__wrapper">${attrEscape(url)}</div></figure>`,
    { url, type: "video", providerNameSlug: "youtube", responsive: true },
  );
}

function renderButtonBlock(a: Record<string, string>): string {
  const href = a.link ?? a.href ?? a.url ?? "#";
  const label = a.label ?? a.text ?? a.title ?? "Read more";
  const target = a.target ? ` target="${attrEscape(a.target)}" rel="noopener"` : "";
  return wpBlock(
    "buttons",
    `<div class="wp-block-buttons"><!-- wp:button -->\n<div class="wp-block-button"><a class="wp-block-button__link" href="${attrEscape(href)}"${target}>${attrEscape(label)}</a></div>\n<!-- /wp:button --></div>`,
  );
}

function renderCalloutBlock(a: Record<string, string>, name: string): string {
  const color = a.color ?? a.type ?? "info";
  const body = a.text ?? a.body ?? a.content ?? "";
  return wpBlock(
    "group",
    `<div class="wp-block-group wpify-callout wpify-callout--${attrEscape(color)}"><p><strong>${attrEscape(name.toUpperCase())}:</strong> ${attrEscape(body)}</p></div>`,
    { className: `wpify-callout wpify-callout--${color}` },
  );
}

function renderGenericShortcode(name: string, a: Record<string, string>): string {
  const shortName = `wpify_${name}`;
  const attrs = Object.entries(a)
    .map(([k, v]) => `${k}="${attrEscape(v)}"`)
    .join(" ");
  // Wrap in a shortcode block so Gutenberg edits it as a single node.
  return `\n\n<!-- wp:shortcode -->\n[${shortName}${attrs ? " " + attrs : ""}]\n<!-- /wp:shortcode -->\n\n`;
}

/**
 * Derive a WordPress post status from the source front-matter, preserving
 * drafts rather than blindly publishing everything. Recognizes the common
 * SSG conventions:
 *   - Jekyll `_drafts/` directory (anything in it is a draft)
 *   - `published: false` (Jekyll 3/4)
 *   - `draft: true` (Hugo, Eleventy, Astro, Next-content)
 *   - `status: draft|publish|private|pending` explicit override
 */
function deriveStatus(
  data: Record<string, unknown>,
  srcPath: string,
): "publish" | "draft" | "private" | "pending" {
  const explicit = String(data.status ?? "").toLowerCase();
  if (explicit === "draft" || explicit === "publish" || explicit === "private" || explicit === "pending") {
    return explicit as "publish" | "draft" | "private" | "pending";
  }
  if (data.published === false) return "draft";
  if (data.draft === true) return "draft";
  if (/[\\/]_drafts[\\/]/.test(srcPath)) return "draft";
  return "publish";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
