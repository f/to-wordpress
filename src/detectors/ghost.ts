import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Detector } from "./types.js";
import { baseContext, walkAll } from "./common.js";

/**
 * Ghost has two common shapes:
 *   - Content-as-folder: directory of markdown files (each post is one .md)
 *   - Ghost export: a JSON dump with `db`, `posts`, `tags`, etc.
 * We handle both.
 */
export const ghostDetector: Detector = {
  name: "ghost-export",
  priority: 75,

  async match(dir) {
    if (existsSync(join(dir, "ghost-export.json"))) return 0.95;
    const jsons = (await walkAll(dir, 2)).filter((p) => p.endsWith(".json"));
    for (const p of jsons) {
      try {
        const raw = await readFile(p, "utf8");
        if (/"db"\s*:\s*\[/.test(raw) && /"posts"\s*:\s*\[/.test(raw)) return 0.85;
      } catch {
        continue;
      }
    }
    return 0;
  },

  async detect(ctx) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "ghost-export";

    const exportPath = await findGhostExport(dir);
    if (!exportPath) return out;

    try {
      const raw = await readFile(exportPath, "utf8");
      const data = JSON.parse(raw) as { db?: Array<{ data?: { posts?: unknown[]; tags?: unknown[] } }> };
      const posts = data.db?.[0]?.data?.posts ?? [];
      out.collections.push({
        name: "posts",
        dir: exportPath,
        permalink: "/:slug/",
        count: Array.isArray(posts) ? posts.length : 0,
      });
    } catch {
      /* ignore */
    }

    return out;
  },
};

async function findGhostExport(dir: string): Promise<string | undefined> {
  if (existsSync(join(dir, "ghost-export.json"))) return join(dir, "ghost-export.json");
  const jsons = (await walkAll(dir, 2)).filter((p) => p.endsWith(".json"));
  for (const p of jsons) {
    try {
      const raw = await readFile(p, "utf8");
      if (/"db"\s*:\s*\[/.test(raw) && /"posts"\s*:\s*\[/.test(raw)) return p;
    } catch {
      continue;
    }
  }
  return undefined;
}
