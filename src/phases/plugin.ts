import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MigrationContext } from "../types.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import type { UiBus } from "../tui/bus.js";
import { runCopilotPhase } from "./theme.js";

export async function runPlugin(ctx: MigrationContext, bus: UiBus): Promise<void> {
  bus.pushStreamEvent("plugin", { type: "phase_start", phase: "plugin", message: "scoring the verses — binding features into a site plugin" });
  const detected = ctx.detected;
  const choices = ctx.choices;
  if (!detected || !choices) throw new Error("plan phase must run before plugin");

  await mkdir(ctx.pluginDir, { recursive: true });
  await mkdir(join(ctx.pluginDir, "includes"), { recursive: true });

  const tpl = await loadPrompt("plugin");
  const pluginSlugUnderscored = detected.pluginSlug.replace(/-/g, "_");
  const shortcodesManifestPath = join(ctx.workDir, "shortcodes.json");
  let discoveredShortcodes: string[] = [];
  if (existsSync(shortcodesManifestPath)) {
    try {
      const parsed = JSON.parse(await readFile(shortcodesManifestPath, "utf8"));
      if (Array.isArray(parsed.shortcodes)) discoveredShortcodes = parsed.shortcodes.map(String);
    } catch {
      /* ignore */
    }
  }
  const ssgPluginSources = detected.ssgPluginSources ?? {};
  const ssgPluginsBlock = Object.keys(ssgPluginSources).length > 0
    ? Object.entries(ssgPluginSources)
        .map(([name, src]) => `### \`${name}\`\n\n\`\`\`ruby\n${src}\n\`\`\``)
        .join("\n\n")
    : "(no SSG plugins detected)";

  // Read the blockify manifest so the plugin prompt knows which blocks exist.
  const blocksManifestPath = join(ctx.workDir, "blocks.json");
  let blocksManifest: { blocks?: Array<{ name: string; slug: string }> } = {};
  if (existsSync(blocksManifestPath)) {
    try {
      blocksManifest = JSON.parse(await readFile(blocksManifestPath, "utf8"));
    } catch {
      /* ignore */
    }
  }

  const prompt = interpolate(tpl, {
    PLUGIN_DIR: ctx.pluginDir,
    PLUGIN_SLUG: detected.pluginSlug,
    PLUGIN_SLUG_UNDERSCORED: pluginSlugUnderscored,
    THEME_SLUG: detected.themeSlug,
    SITE_TITLE: detected.siteTitle ?? detected.themeSlug,
    SOURCE_KIND: detected.kind,
    DETECTOR_BRIEFING: detected.detectorBriefing ?? "(no detector briefing)",
    DETECTED_JSON: JSON.stringify(detected, null, 2),
    CHOICES_JSON: JSON.stringify(choices, null, 2),
    SHORTCODES_JSON: JSON.stringify(discoveredShortcodes, null, 2),
    SHORTCODES_LIST: discoveredShortcodes.length > 0
      ? discoveredShortcodes.map((n) => `- towp_${n}`).join("\n")
      : "(none detected)",
    SHORTCODES_LIST_PHP: discoveredShortcodes.length > 0
      ? discoveredShortcodes.map((n) => `'${n.replace(/'/g, "\\'")}'`).join(", ")
      : "",
    SSG_PLUGINS_SOURCE: ssgPluginsBlock,
    BLOCKS_JSON: JSON.stringify(blocksManifest.blocks ?? [], null, 2),
  });

  const result = await runCopilotPhase(bus, "plugin", {
    prompt,
    cwd: ctx.sourceDir,
    addDirs: [ctx.sourceDir, ctx.pluginDir],
    resumeSessionId: ctx.copilotSessionId,
    maxAutopilotContinues: 80,
    timeoutMs: 20 * 60 * 1000,
  });
  if (result.sessionId) ctx.copilotSessionId = result.sessionId;

  const mainFile = join(ctx.pluginDir, `${detected.pluginSlug}.php`);
  const humanName = `${detected.siteTitle ?? detected.themeSlug} Site`;
  if (!existsSync(mainFile)) {
    bus.pushStreamEvent("plugin", {
      type: "warn",
      phase: "plugin",
      message: "plugin bootstrap missing after copilot run — writing fallback",
    });
    await writeFile(
      mainFile,
      `<?php\n/**\n * Plugin Name: ${humanName}\n * Description: Site-specific plugin for ${detected.siteTitle ?? detected.themeSlug} — CPTs, shortcodes, redirects, analytics, and other non-theme features migrated by to-wordpress.\n * Version: 0.1.0\n * License: GPL-2.0-or-later\n * Text Domain: ${detected.pluginSlug}\n */\nif (!defined('ABSPATH')) { exit; }\nforeach (glob(plugin_dir_path(__FILE__) . 'includes/*.php') as $__inc) { require_once $__inc; }\n`,
      "utf8",
    );
  }

  const cptFile = join(ctx.pluginDir, "includes", "cpt.php");
  if (choices.customPostTypes.length > 0 && !existsSync(cptFile)) {
    await writeFile(cptFile, buildCptFallback(choices.customPostTypes, detected.pluginSlug), "utf8");
  }

  // Guarantee every detected shortcode is registered with a PHP callback,
  // even if Copilot missed one. An unregistered `[towp_figure ...]` would
  // otherwise render as literal bracket text in a published post.
  const shortcodesFile = join(ctx.pluginDir, "includes", "shortcodes.php");
  if (discoveredShortcodes.length > 0 && !existsSync(shortcodesFile)) {
    await writeFile(shortcodesFile, buildShortcodesFallback(discoveredShortcodes), "utf8");
    bus.pushStreamEvent("plugin", {
      type: "warn",
      phase: "plugin",
      message: `shortcodes.php missing — wrote ${discoveredShortcodes.length}-shortcode fallback`,
    });
  }

  if (result.exitCode !== 0) {
    bus.pushStreamEvent("plugin", { type: "phase_fail", phase: "plugin", message: `copilot exited with ${result.exitCode}` });
    throw new Error(`plugin phase failed (copilot ${result.exitCode})`);
  }
  bus.pushStreamEvent("plugin", { type: "phase_ok", phase: "plugin" });
}

function buildCptFallback(
  cpts: Array<{ name: string; slug: string; pathPrefix: string }>,
  textDomain: string,
): string {
  const lines = ["<?php", "if (!defined('ABSPATH')) { exit; }", "add_action('init', function () {"];
  for (const cpt of cpts) {
    const label = cpt.name.charAt(0).toUpperCase() + cpt.name.slice(1);
    lines.push(`  register_post_type(${php(cpt.slug)}, [`);
    lines.push(`    'label' => ${php(label)},`);
    lines.push(`    'public' => true,`);
    lines.push(`    'show_in_rest' => true,`);
    lines.push(`    'has_archive' => true,`);
    lines.push(`    'supports' => ['title','editor','excerpt','thumbnail','custom-fields','author'],`);
    lines.push(`    'rewrite' => ['slug' => ${php(cpt.pathPrefix || cpt.slug)}, 'with_front' => false],`);
    lines.push(`  ]);`);
  }
  lines.push("});", "");
  return lines.join("\n");
}

function php(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/**
 * Synthesize a generic PHP file that registers every shortcode the
 * normalize phase emitted. Each handler renders a semantic wrapper with
 * all source attributes exposed as `data-*`. Copilot is expected to
 * overwrite this with proper per-shortcode markup, but the fallback
 * guarantees the rendered post never leaks raw `[towp_xyz …]` text.
 */
function buildShortcodesFallback(names: string[]): string {
  const lines: string[] = [
    "<?php",
    "// Synthesized by to-wordpress (src/phases/plugin.ts). Replace each",
    "// handler with the real template from the source site (look in",
    "// _includes/framework/shortcodes/ or _includes/shortcodes/).",
    "if ( ! defined( 'ABSPATH' ) ) { exit; }",
    "",
    "if ( ! function_exists( 'towp_shortcode_attrs_to_data' ) ) {",
    "    function towp_shortcode_attrs_to_data( $atts ) {",
    "        $out = '';",
    "        foreach ( (array) $atts as $k => $v ) {",
    "            $out .= ' data-' . sanitize_key( $k ) . '=\"' . esc_attr( $v ) . '\"';",
    "        }",
    "        return $out;",
    "    }",
    "}",
    "",
    "add_action( 'init', function () {",
  ];
  for (const n of names) {
    lines.push(
      `    add_shortcode( 'towp_${n}', function ( $atts, $content = null ) {`,
      `        $atts = shortcode_atts( [], (array) $atts, 'towp_${n}' );`,
      `        $data = towp_shortcode_attrs_to_data( $atts );`,
      `        $label = esc_html( 'towp_${n}' );`,
      `        $inner = $content ? wp_kses_post( $content ) : '';`,
      `        return '<div class="towp-shortcode towp-shortcode--${n}"' . $data . '>' . $inner . '</div>';`,
      `    } );`,
    );
  }
  lines.push("} );", "");
  return lines.join("\n");
}
