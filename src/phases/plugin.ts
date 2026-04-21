import { mkdir, writeFile } from "node:fs/promises";
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
  const prompt = interpolate(tpl, {
    PLUGIN_DIR: ctx.pluginDir,
    PLUGIN_SLUG: detected.pluginSlug,
    PLUGIN_SLUG_UNDERSCORED: pluginSlugUnderscored,
    THEME_SLUG: detected.themeSlug,
    SITE_TITLE: detected.siteTitle ?? detected.themeSlug,
    DETECTED_JSON: JSON.stringify(detected, null, 2),
    CHOICES_JSON: JSON.stringify(choices, null, 2),
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
  if (!existsSync(mainFile)) {
    bus.pushStreamEvent("plugin", {
      type: "warn",
      phase: "plugin",
      message: "plugin bootstrap missing after copilot run — writing fallback",
    });
    await writeFile(
      mainFile,
      `<?php\n/**\n * Plugin Name: ${detected.pluginSlug}\n * Description: Site-specific plugin for the migrated site.\n * Version: 0.1.0\n * License: GPL-2.0-or-later\n * Text Domain: ${detected.pluginSlug}\n */\nif (!defined('ABSPATH')) { exit; }\nforeach (glob(plugin_dir_path(__FILE__) . 'includes/*.php') as $__inc) { require_once $__inc; }\n`,
      "utf8",
    );
  }

  const cptFile = join(ctx.pluginDir, "includes", "cpt.php");
  if (choices.customPostTypes.length > 0 && !existsSync(cptFile)) {
    await writeFile(cptFile, buildCptFallback(choices.customPostTypes, detected.pluginSlug), "utf8");
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
