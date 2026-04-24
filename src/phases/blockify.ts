import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MigrationContext } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import { runCopilotPhase } from "./theme.js";

export interface BlockifyResult {
  blocks: Array<{ name: string; slug: string; dir: string }>;
  rewrittenFiles: number;
}

/**
 * Blockify phase. Takes the shortcodes emitted by normalize and:
 *
 *   1) Invokes Copilot to generate proper Gutenberg blocks (block.json,
 *      render.php, edit.js, style.css) under {{PLUGIN_DIR}}/blocks/<name>/
 *      for each discovered shortcode. Uses apiVersion 3 (WP 6.9+).
 *
 *   2) Deterministically rewrites every normalized content file so that
 *      `[towp_xxx attrs]...[/towp_xxx]` becomes proper block markup:
 *      `<!-- wp:<plugin-slug>/xxx {"attrs":...} -->...<!-- /wp:<plugin-slug>/xxx -->`.
 *      Self-closing shortcodes become self-closing block comments.
 *
 *   3) Writes `blocks.json` manifest so the plugin phase knows which
 *      blocks to register.
 */
export async function runBlockify(ctx: MigrationContext, bus: UiBus): Promise<BlockifyResult> {
  bus.pushStreamEvent("blockify", {
    type: "phase_start",
    phase: "blockify",
    message: "casting the blocks — turning reusable parts into Gutenberg blocks",
  });

  const detected = ctx.detected;
  if (!detected) throw new Error("detect phase must run before blockify");

  const shortcodesPath = join(ctx.workDir, "shortcodes.json");
  if (!existsSync(shortcodesPath)) {
    bus.pushStreamEvent("blockify", {
      type: "info",
      phase: "blockify",
      message: "no shortcodes.json found — nothing to blockify",
    });
    bus.pushStreamEvent("blockify", { type: "phase_ok", phase: "blockify" });
    return { blocks: [], rewrittenFiles: 0 };
  }

  let shortcodes: string[] = [];
  try {
    const raw = await readFile(shortcodesPath, "utf8");
    const parsed = JSON.parse(raw) as { shortcodes?: string[] };
    shortcodes = parsed.shortcodes ?? [];
  } catch {
    shortcodes = [];
  }

  if (shortcodes.length === 0) {
    bus.pushStreamEvent("blockify", {
      type: "info",
      phase: "blockify",
      message: "no shortcodes discovered — nothing to blockify",
    });
    bus.pushStreamEvent("blockify", { type: "phase_ok", phase: "blockify" });
    return { blocks: [], rewrittenFiles: 0 };
  }

  bus.pushStreamEvent("blockify", {
    type: "info",
    phase: "blockify",
    message: `found ${shortcodes.length} shortcode(s) to convert: ${shortcodes.join(", ")}`,
  });

  const blocksDir = join(ctx.pluginDir, "blocks");
  await mkdir(blocksDir, { recursive: true });

  // Collect source templates so Copilot can port their logic.
  const sourceTemplates: Record<string, string> = {};
  for (const name of shortcodes) {
    const candidates = [
      join(ctx.sourceDir, "_includes", "framework", "shortcodes", `${name}.html`),
      join(ctx.sourceDir, "_includes", "shortcodes", `${name}.html`),
      join(ctx.sourceDir, "_includes", `${name}.html`),
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        try {
          sourceTemplates[name] = await readFile(c, "utf8");
        } catch {
          /* ignore */
        }
        break;
      }
    }
  }

  const pluginSlugUnderscored = detected.pluginSlug.replace(/-/g, "_");

  if (!ctx.flags.skipCopilot) {
    const tpl = await loadPrompt("blockify");
    const templatesBlock = Object.keys(sourceTemplates).length > 0
      ? Object.entries(sourceTemplates)
          .map(([name, src]) => `### \`${name}\` — source template\n\n\`\`\`liquid\n${src}\n\`\`\``)
          .join("\n\n")
      : "(no source templates found — infer reasonable attributes from the shortcode name alone)";

    const prompt = interpolate(tpl, {
      BLOCKS_DIR: blocksDir,
      PLUGIN_SLUG: detected.pluginSlug,
      PLUGIN_SLUG_UNDERSCORED: pluginSlugUnderscored,
      SHORTCODES_JSON: JSON.stringify(shortcodes, null, 2),
      SOURCE_TEMPLATES: templatesBlock,
      CONTENT_DIR: ctx.contentDir,
      SOURCE_DIR: ctx.sourceDir,
    });

    const result = await runCopilotPhase(bus, "blockify", {
      prompt,
      cwd: ctx.sourceDir,
      addDirs: [ctx.sourceDir, ctx.pluginDir, ctx.contentDir],
      resumeSessionId: ctx.copilotSessionId,
      maxAutopilotContinues: 80,
      timeoutMs: 20 * 60 * 1000,
    });
    if (result.sessionId) ctx.copilotSessionId = result.sessionId;
  } else {
    bus.pushStreamEvent("blockify", {
      type: "info",
      phase: "blockify",
      message: "copilot skipped — writing fallback block definitions",
    });
    for (const name of shortcodes) {
      await writeBlockFallback(blocksDir, name, detected.pluginSlug);
    }
  }

  // Discover what Copilot actually produced, so the manifest + content rewrite
  // only reference real blocks.
  const generated: Array<{ name: string; slug: string; dir: string }> = [];
  if (existsSync(blocksDir)) {
    const entries = await readdir(blocksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const blockJsonPath = join(blocksDir, entry.name, "block.json");
      if (!existsSync(blockJsonPath)) continue;
      try {
        const bj = JSON.parse(await readFile(blockJsonPath, "utf8")) as { name?: string };
        if (bj.name && bj.name.includes("/")) {
          const [, slug] = bj.name.split("/");
          generated.push({ name: bj.name, slug, dir: join(blocksDir, entry.name) });
        }
      } catch {
        /* invalid block.json — skip */
      }
    }
  }

  // Ensure every shortcode got a block. If Copilot missed some, write fallbacks.
  for (const name of shortcodes) {
    if (!generated.some((b) => b.slug === name)) {
      await writeBlockFallback(blocksDir, name, detected.pluginSlug);
      generated.push({
        name: `${detected.pluginSlug}/${name}`,
        slug: name,
        dir: join(blocksDir, name),
      });
    }
  }

  // Persist the manifest for the plugin phase.
  await writeFile(
    join(ctx.workDir, "blocks.json"),
    JSON.stringify({ blocks: generated }, null, 2) + "\n",
    "utf8",
  );

  // Rewrite content files: shortcodes → block comments.
  const rewrittenFiles = await rewriteContentShortcodesToBlocks(
    ctx.contentDir,
    generated.map((b) => b.slug),
    detected.pluginSlug,
  );

  bus.pushStreamEvent("blockify", {
    type: "info",
    phase: "blockify",
    message: `generated ${generated.length} block(s), rewrote ${rewrittenFiles} content file(s)`,
  });

  bus.pushStreamEvent("blockify", { type: "phase_ok", phase: "blockify" });
  return { blocks: generated, rewrittenFiles };
}

/**
 * Walk the content directory and rewrite `[towp_xxx ...]` shortcodes as
 * Gutenberg block comments. Handles both self-closing and enclosing forms.
 * Idempotent: running twice leaves already-rewritten files unchanged.
 */
async function rewriteContentShortcodesToBlocks(
  contentDir: string,
  names: string[],
  pluginSlug: string,
): Promise<number> {
  if (!existsSync(contentDir) || names.length === 0) return 0;
  const files = await walkMarkdown(contentDir);
  let count = 0;
  for (const file of files) {
    const original = await readFile(file, "utf8");
    const rewritten = rewriteShortcodes(original, names, pluginSlug);
    if (rewritten !== original) {
      await writeFile(file, rewritten, "utf8");
      count++;
    }
  }
  return count;
}

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkMarkdown(p)));
    else if (p.endsWith(".md") || p.endsWith(".html")) out.push(p);
  }
  return out;
}

function rewriteShortcodes(content: string, names: string[], pluginSlug: string): string {
  if (!content.includes("[towp_")) return content;
  if (names.length === 0) return content;

  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  // Enclosing form: [towp_X attrs]inner[/towp_X]
  const enclosing = new RegExp(
    `\\[towp_(${escaped})([^\\]]*)\\]([\\s\\S]*?)\\[\\/towp_\\1\\]`,
    "g",
  );
  let out = content.replace(enclosing, (_match, name: string, attrsRaw: string, inner: string) => {
    const attrs = parseShortcodeAttrs(attrsRaw);
    const suffix = Object.keys(attrs).length > 0 ? " " + JSON.stringify(attrs) : "";
    const ns = `${pluginSlug}/${name}`;
    return `<!-- wp:${ns}${suffix} -->\n${inner.trim()}\n<!-- /wp:${ns} -->`;
  });

  // Self-closing form: [towp_X attrs]
  const selfClosing = new RegExp(`\\[towp_(${escaped})([^\\]]*)\\]`, "g");
  out = out.replace(selfClosing, (_match, name: string, attrsRaw: string) => {
    const attrs = parseShortcodeAttrs(attrsRaw);
    const suffix = Object.keys(attrs).length > 0 ? " " + JSON.stringify(attrs) : "";
    const ns = `${pluginSlug}/${name}`;
    return `<!-- wp:${ns}${suffix} /-->`;
  });

  return out;
}

function parseShortcodeAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w[\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    attrs[m[1]] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  return attrs;
}

/**
 * Minimal synthetic block used when Copilot fails to produce one. Produces
 * a valid apiVersion 3 block that renders an accessible placeholder so
 * the content still displays something sensible. User should replace the
 * render.php with real source-template logic afterward.
 */
async function writeBlockFallback(
  blocksDir: string,
  name: string,
  pluginSlug: string,
): Promise<void> {
  const dir = join(blocksDir, name);
  await mkdir(dir, { recursive: true });

  const blockJson = {
    $schema: "https://schemas.wp.org/trunk/block.json",
    apiVersion: 3,
    name: `${pluginSlug}/${name}`,
    title: humanize(name),
    category: "widgets",
    description: `Synthesized block for legacy shortcode \`towp_${name}\`. Replace render.php with real logic from the source template.`,
    textdomain: pluginSlug,
    supports: { html: false, align: ["wide", "full"] },
    attributes: {
      src: { type: "string" },
      alt: { type: "string" },
      caption: { type: "string" },
    },
    render: "file:./render.php",
    style: "file:./style.css",
    editorStyle: "file:./editor.css",
  };

  await writeFile(join(dir, "block.json"), JSON.stringify(blockJson, null, 2) + "\n", "utf8");

  const renderPhp = `<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

$wrapper = get_block_wrapper_attributes( [
    'class' => 'towp-block towp-block-${name}',
] );
$atts = wp_parse_args( (array) ( $attributes ?? [] ), [
    'src'     => '',
    'alt'     => '',
    'caption' => '',
] );
?>
<div <?php echo $wrapper; ?>>
    <?php if ( ! empty( $atts['src'] ) ) : ?>
        <img src="<?php echo esc_url( $atts['src'] ); ?>" alt="<?php echo esc_attr( $atts['alt'] ); ?>" />
    <?php endif; ?>
    <?php if ( ! empty( $atts['caption'] ) ) : ?>
        <figcaption><?php echo esc_html( $atts['caption'] ); ?></figcaption>
    <?php endif; ?>
    <?php echo wp_kses_post( $content ?? '' ); ?>
</div>
`;
  await writeFile(join(dir, "render.php"), renderPhp, "utf8");

  const css = `.towp-block-${name} { display: block; }\n`;
  await writeFile(join(dir, "style.css"), css, "utf8");
  await writeFile(join(dir, "editor.css"), css, "utf8");
}

function humanize(s: string): string {
  return s
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
