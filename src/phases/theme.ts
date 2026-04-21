import { cp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { MigrationContext } from "../types.js";
import { runCopilot } from "../copilot/run.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import type { UiBus } from "../tui/bus.js";
import { readSample, runPrerender, type PrerenderResult } from "./prerender.js";

const REQUIRED_TEMPLATES = [
  "style.css",
  "functions.php",
  "index.php",
  "header.php",
  "footer.php",
  "single.php",
  "page.php",
];

export async function runTheme(ctx: MigrationContext, bus: UiBus): Promise<void> {
  bus.pushStreamEvent("theme", { type: "phase_start", phase: "theme", message: "weaving the theme — turning verses of Liquid into PHP" });
  const detected = ctx.detected;
  if (!detected) throw new Error("detect phase must run before theme");

  await mkdir(ctx.themeDir, { recursive: true });
  await writeThemeJsonSeed(ctx.themeDir, detected);
  await mirrorSourceIntoTheme(ctx, bus);
  const prerender = await runPrerender(ctx, bus);
  const renderedSection = await buildRenderedReference(prerender);

  const tpl = await loadPrompt("theme");
  const pages = ctx.choices?.pages ?? [];
  const pagesTable = pages.length
    ? [
        "| slug | title | permalink | source layout | role | required template |",
        "|---|---|---|---|---|---|",
        ...pages.map((p) => {
          const file = p.layout ? `page-${p.layout}.php` : "page.php";
          return `| \`${p.slug}\` | ${p.title} | ${p.permalink ?? "-"} | ${p.layout ?? "-"} | ${p.role ?? "-"} | \`${file}\` |`;
        }),
      ].join("\n")
    : "_No standalone pages detected._";
  const prompt = interpolate(tpl, {
    SOURCE_DIR: ctx.sourceDir,
    THEME_DIR: ctx.themeDir,
    THEME_SLUG: detected.themeSlug,
    SITE_TITLE: detected.siteTitle ?? detected.themeSlug,
    LAYOUTS_LIST: detected.layouts.join("\n"),
    DETECTED_JSON: JSON.stringify(detected, null, 2),
    PAGES_TABLE: pagesTable,
    FRONT_PAGE_SLUG: ctx.choices?.frontPageSlug ?? "(none)",
    BLOG_INDEX_PAGE_SLUG: ctx.choices?.blogIndexPageSlug ?? "(none)",
    PRIVACY_PAGE_SLUG: ctx.choices?.privacyPageSlug ?? "(none)",
    RENDERED_REFERENCE: renderedSection,
    RENDERED_DIR: prerender.renderedDir ?? "(prerender unavailable)",
    MIRRORED_SOURCE: buildMirroredSummary(ctx, detected),
  });

  const result = await runCopilotPhase(bus, "theme", {
    prompt,
    cwd: ctx.sourceDir,
    addDirs: [ctx.sourceDir, ctx.themeDir, prerender.renderedDir ?? ctx.workDir],
    resumeSessionId: ctx.copilotSessionId,
    maxAutopilotContinues: 200,
    timeoutMs: 45 * 60 * 1000,
  });
  if (result.sessionId) ctx.copilotSessionId = result.sessionId;

  const missing = REQUIRED_TEMPLATES.filter((f) => !existsSync(join(ctx.themeDir, f)));
  if (missing.length > 0) {
    bus.pushStreamEvent("theme", {
      type: "warn",
      phase: "theme",
      message: `missing after copilot run: ${missing.join(", ")} — writing fallbacks`,
    });
    await writeThemeFallbacks(ctx.themeDir, detected, missing);
  }

  if (result.exitCode !== 0) {
    bus.pushStreamEvent("theme", { type: "phase_fail", phase: "theme", message: `copilot exited with ${result.exitCode}` });
    throw new Error(`theme phase failed (copilot ${result.exitCode})`);
  }
  bus.pushStreamEvent("theme", { type: "phase_ok", phase: "theme" });
}

async function mirrorSourceIntoTheme(ctx: MigrationContext, bus: UiBus): Promise<void> {
  const detected = ctx.detected!;
  const mirrors: Array<{ src: string; dst: string }> = [];

  if (detected.kind === "jekyll") {
    mirrors.push(
      { src: join(ctx.sourceDir, "_sass"), dst: join(ctx.themeDir, "_sass_source") },
      { src: join(ctx.sourceDir, "assets"), dst: join(ctx.themeDir, "assets") },
      { src: join(ctx.sourceDir, "_data"), dst: join(ctx.themeDir, "_data_source") },
      { src: join(ctx.sourceDir, "_layouts"), dst: join(ctx.themeDir, "_source_layouts") },
      { src: join(ctx.sourceDir, "_includes"), dst: join(ctx.themeDir, "_source_includes") },
    );
  } else {
    for (const d of detected.assetsDirs) {
      mirrors.push({ src: d, dst: join(ctx.themeDir, basename(d)) });
    }
  }

  for (const { src, dst } of mirrors) {
    if (!existsSync(src)) continue;
    try {
      await cp(src, dst, { recursive: true, force: true, errorOnExist: false });
      bus.pushStreamEvent("theme", {
        type: "info",
        phase: "theme",
        message: `mirrored ${basename(src)} → ${basename(dst)}`,
      });
    } catch (err) {
      bus.pushStreamEvent("theme", {
        type: "warn",
        phase: "theme",
        message: `mirror ${basename(src)} failed: ${(err as Error).message}`,
      });
    }
  }
}

function buildMirroredSummary(ctx: MigrationContext, detected: NonNullable<MigrationContext["detected"]>): string {
  if (detected.kind === "jekyll") {
    return [
      `- \`${ctx.themeDir}/_sass_source/\` — verbatim copy of \`_sass/\`. Compile into \`style.css\` (keep every selector).`,
      `- \`${ctx.themeDir}/assets/\` — verbatim copy of \`assets/\`. Reference with \`get_template_directory_uri() . '/assets/...'\`.`,
      `- \`${ctx.themeDir}/_data_source/\` — the site's \`_data/*.yml|json\` (menu, social, authors, partners, contact). Inline the values into PHP (load YAML via a tiny parser or transcribe to PHP arrays in a new \`inc/data.php\`).`,
      `- \`${ctx.themeDir}/_source_layouts/\` and \`${ctx.themeDir}/_source_includes/\` — the original Liquid templates for line-by-line reference.`,
    ].join("\n");
  }
  return "- Assets mirrored into the theme directory; layouts available in the source directory.";
}

async function buildRenderedReference(pr: PrerenderResult): Promise<string> {
  if (!pr.ok || pr.samples.length === 0) {
    return "Ground-truth rendering is not available for this source. Work from the source templates directly and keep structure + classnames identical.";
  }
  const parts: string[] = [
    "Ground-truth rendered HTML from building the source site is available in:",
    `\`${pr.renderedDir}\``,
    "",
    "Your PHP templates MUST produce HTML with the same DOM structure, class names, and text content as the following reference pages. The tool will compare rendered output during Verify, so any missing hero heading, missing image, missing menu item, or different section markup WILL fail the migration.",
    "",
  ];
  for (const s of pr.samples) {
    const html = await readSample(s.filePath, 5000);
    parts.push(`### ${s.kind} — ${s.sourceUrl} (file: \`${s.filePath}\`)\n\n\`\`\`html\n${html}\n\`\`\`\n`);
  }
  return parts.join("\n");
}

async function writeThemeJsonSeed(themeDir: string, detected: NonNullable<MigrationContext["detected"]>): Promise<void> {
  const colors = detected.colors ?? {};
  const fonts = detected.fonts ?? {};
  const paletteSource: Record<string, string | undefined> = {
    primary: colors.primary_bg,
    "primary-contrast": colors.primary_text,
    background: colors.base_bg,
    "background-alt": colors.base_bg_2,
    foreground: colors.base_text,
    "foreground-muted": colors.base_text_2,
  };
  const palette = Object.entries(paletteSource)
    .filter((e): e is [string, string] => typeof e[1] === "string" && /^#/.test(e[1]))
    .map(([slug, color]) => ({ slug, color, name: slug }));
  const families = [
    fonts.base && { fontFamily: fonts.base, slug: "base", name: fonts.base },
    fonts.heading && fonts.heading !== fonts.base && { fontFamily: fonts.heading, slug: "heading", name: fonts.heading },
    fonts.monospace && { fontFamily: fonts.monospace, slug: "mono", name: fonts.monospace },
  ].filter(Boolean);
  const themeJson = {
    $schema: "https://schemas.wp.org/trunk/theme.json",
    version: 2,
    settings: {
      color: palette.length > 0 ? { palette } : undefined,
      typography: families.length > 0 ? { fontFamilies: families } : undefined,
    },
  };
  await writeFile(join(themeDir, "theme.json"), JSON.stringify(themeJson, null, 2) + "\n", "utf8");
}

async function writeThemeFallbacks(
  themeDir: string,
  detected: NonNullable<MigrationContext["detected"]>,
  missing: string[],
): Promise<void> {
  const name = detected.siteTitle ?? detected.themeSlug;
  const write = async (file: string, body: string) => {
    if (missing.includes(file)) await writeFile(join(themeDir, file), body, "utf8");
  };
  await write(
    "style.css",
    `/*\nTheme Name: ${name}\nDescription: Generated by to-wordpress (fallback).\nVersion: 0.1.0\nText Domain: ${detected.themeSlug}\n*/\n`,
  );
  await write(
    "functions.php",
    `<?php\nif (!defined('ABSPATH')) { exit; }\nadd_action('after_setup_theme', function () {\n  add_theme_support('title-tag');\n  add_theme_support('post-thumbnails');\n  add_theme_support('html5', ['caption','comment-form','comment-list','gallery','search-form','script','style']);\n  register_nav_menus(['primary' => __('Primary', '${detected.themeSlug}'), 'footer' => __('Footer', '${detected.themeSlug}')]);\n});\nadd_action('wp_enqueue_scripts', function () {\n  wp_enqueue_style('${detected.themeSlug}', get_stylesheet_uri(), [], wp_get_theme()->get('Version'));\n});\n`,
  );
  await write("header.php", "<!DOCTYPE html><html <?php language_attributes(); ?>><head><meta charset=\"<?php bloginfo('charset'); ?>\" /><?php wp_head(); ?></head><body <?php body_class(); ?>>\n");
  await write("footer.php", "<?php wp_footer(); ?></body></html>\n");
  await write(
    "index.php",
    "<?php get_header(); ?>\n<main>\n<?php if (have_posts()) : while (have_posts()) : the_post(); ?>\n<article><h2><a href=\"<?php the_permalink(); ?>\"><?php the_title(); ?></a></h2><?php the_excerpt(); ?></article>\n<?php endwhile; endif; ?>\n</main>\n<?php get_footer(); ?>\n",
  );
  await write(
    "single.php",
    "<?php get_header(); ?>\n<main>\n<?php while (have_posts()) : the_post(); ?>\n<article><h1><?php the_title(); ?></h1><?php the_content(); ?></article>\n<?php endwhile; ?>\n</main>\n<?php get_footer(); ?>\n",
  );
  await write(
    "page.php",
    "<?php get_header(); ?>\n<main>\n<?php while (have_posts()) : the_post(); ?>\n<article><h1><?php the_title(); ?></h1><?php the_content(); ?></article>\n<?php endwhile; ?>\n</main>\n<?php get_footer(); ?>\n",
  );
}

export async function runCopilotPhase(
  bus: UiBus,
  phase: Parameters<UiBus["pushStreamEvent"]>[0],
  opts: Parameters<typeof runCopilot>[0],
): Promise<{ exitCode: number; sessionId?: string }> {
  const iter = runCopilot(opts);
  let sessionId: string | undefined;
  let exitCode = 0;
  while (true) {
    const next = await iter.next();
    if (next.done) {
      sessionId = next.value.sessionId ?? sessionId;
      exitCode = next.value.exitCode;
      break;
    }
    bus.pushStreamEvent(phase, next.value);
    if (next.value.type === "session") sessionId = next.value.sessionId;
    if (next.value.type === "done") exitCode = next.value.exitCode;
  }
  return { exitCode, sessionId };
}
