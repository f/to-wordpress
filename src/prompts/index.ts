import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

async function readPromptFile(name: string): Promise<string> {
  const candidates = [
    join(here, "prompts", `${name}.md`),
    join(here, "..", "prompts", `${name}.md`),
    join(here, "..", "..", "src", "prompts", `${name}.md`),
    join(here, "..", "src", "prompts", `${name}.md`),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, "utf8");
    } catch {
      /* try next */
    }
  }
  throw new Error(`prompt template not found: ${name}`);
}

/**
 * Read a prompt template from disk. If the template contains `{{SHARED}}`
 * the shared orchestration preamble (`_shared.md`) is inlined at that spot
 * so every phase gets the same autonomy + fidelity rules.
 */
export async function loadPrompt(name: string): Promise<string> {
  const raw = await readPromptFile(name);
  if (!raw.includes("{{SHARED}}")) return raw;
  const shared = await readPromptFile("_shared");
  return raw.replace(/\{\{SHARED\}\}/g, shared.trim());
}

export function interpolate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? `{{${k}}}`));
}
