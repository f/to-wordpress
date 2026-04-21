import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Detector } from "./types.js";
import { baseContext, listFiles, readCname } from "./common.js";

const CONFIG_FILES = ["hugo.toml", "hugo.yaml", "hugo.yml", "hugo.json", "config.toml", "config.yaml", "config.yml"];

export const hugoDetector: Detector = {
  name: "hugo",
  priority: 95,

  async match(dir) {
    const hasConfig = CONFIG_FILES.some((f) => existsSync(join(dir, f)));
    if (!hasConfig) return 0;
    let score = 0.5;
    if (existsSync(join(dir, "content"))) score += 0.25;
    if (existsSync(join(dir, "layouts"))) score += 0.15;
    if (existsSync(join(dir, "themes"))) score += 0.05;
    if (existsSync(join(dir, "archetypes"))) score += 0.05;
    return Math.min(1, score);
  },

  async detect(ctx, bus) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "hugo";

    const configFile = CONFIG_FILES.map((f) => join(dir, f)).find((p) => existsSync(p));
    let config: Record<string, unknown> = {};
    if (configFile) {
      try {
        const raw = await readFile(configFile, "utf8");
        if (configFile.endsWith(".toml")) config = parseToml(raw);
        else if (configFile.endsWith(".json")) config = JSON.parse(raw) as Record<string, unknown>;
        else config = (parseYaml(raw) ?? {}) as Record<string, unknown>;
      } catch (err) {
        bus.pushStreamEvent("detect", {
          type: "warn",
          phase: "detect",
          message: `hugo: failed to parse ${configFile}: ${(err as Error).message}`,
        });
      }
    }

    out.siteTitle = (config.title as string | undefined) ?? undefined;
    out.domain = (config.baseURL as string | undefined) ?? (config.baseurl as string | undefined) ?? (await readCname(dir));

    out.layouts = await listFiles(join(dir, "layouts"), ".html");
    if (existsSync(join(dir, "assets"))) out.assetsDirs.push(join(dir, "assets"));
    if (existsSync(join(dir, "static"))) out.assetsDirs.push(join(dir, "static"));
    out.dataFiles = await listFiles(join(dir, "data"));

    const contentRoot = join(dir, "content");
    if (existsSync(contentRoot)) {
      const allMd = await listFiles(contentRoot, ".md");
      const sections = new Map<string, string[]>();
      for (const p of allMd) {
        const rel = p.slice(contentRoot.length + 1);
        const section = rel.split("/")[0] ?? "";
        if (!section || /\.md$/.test(section)) {
          if (!sections.has("pages")) sections.set("pages", []);
          sections.get("pages")!.push(p);
        } else {
          if (!sections.has(section)) sections.set(section, []);
          sections.get(section)!.push(p);
        }
      }
      for (const [name, files] of sections) {
        if (name === "pages") {
          out.pages = files;
        } else {
          out.collections.push({
            name,
            dir: join(contentRoot, name),
            permalink: `/${name}/:slug/`,
            count: files.length,
          });
        }
      }
    }

    return out;
  },
};

function parseToml(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
