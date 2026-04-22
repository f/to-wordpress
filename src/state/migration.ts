import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DetectedContext, MigrationContext, PhaseId, UserChoices } from "../types.js";

export interface MigrationDoc {
  version: number;
  sourceDir: string;
  createdAt: string;
  updatedAt: string;
  copilotSessionId?: string;
  detected?: DetectedContext;
  choices?: UserChoices;
  phases: Record<PhaseId, { status: string; startedAt?: string; finishedAt?: string; notes?: string }>;
  notes: string[];
  sections?: Array<{ heading: string; body: string }>;
}

/**
 * Append or update a human-readable section in the migration doc. Sections
 * are matched by heading (case-insensitive); setting the same heading twice
 * replaces the previous body instead of duplicating it. Persisted between
 * runs because the state block is read back on the next invocation.
 */
export function setSection(doc: MigrationDoc, heading: string, body: string): void {
  if (!doc.sections) doc.sections = [];
  const idx = doc.sections.findIndex((s) => s.heading.toLowerCase() === heading.toLowerCase());
  if (idx >= 0) doc.sections[idx] = { heading, body };
  else doc.sections.push({ heading, body });
}

const MARKER_START = "<!-- WPIFY:STATE:START";
const MARKER_END = "WPIFY:STATE:END -->";

export function emptyDoc(sourceDir: string): MigrationDoc {
  const now = new Date().toISOString();
  return {
    version: 1,
    sourceDir,
    createdAt: now,
    updatedAt: now,
    phases: {
      detect: { status: "pending" },
      plan: { status: "pending" },
      boot: { status: "pending" },
      theme: { status: "pending" },
      plugin: { status: "pending" },
      normalize: { status: "pending" },
      import: { status: "pending" },
      verify: { status: "pending" },
      fix: { status: "pending" },
      testfix: { status: "pending" },
    },
    notes: [],
  };
}

export async function loadMigrationDoc(path: string, sourceDir: string): Promise<MigrationDoc> {
  if (!existsSync(path)) return emptyDoc(sourceDir);
  const raw = await readFile(path, "utf8");
  const start = raw.indexOf(MARKER_START);
  const end = raw.indexOf(MARKER_END);
  if (start < 0 || end < 0) return emptyDoc(sourceDir);
  const jsonStart = raw.indexOf("\n", start) + 1;
  const jsonBlock = raw.slice(jsonStart, end).trim();
  try {
    return normalizeDoc(JSON.parse(jsonBlock) as MigrationDoc, sourceDir);
  } catch {
    return emptyDoc(sourceDir);
  }
}

function normalizeDoc(doc: MigrationDoc, sourceDir: string): MigrationDoc {
  const base = emptyDoc(sourceDir);
  const phases = { ...base.phases, ...(doc.phases ?? {}) };
  return {
    ...base,
    ...doc,
    sourceDir: doc.sourceDir ?? sourceDir,
    phases,
    notes: doc.notes ?? [],
  };
}

export async function saveMigrationDoc(
  path: string,
  doc: MigrationDoc,
  extraSections: Array<{ heading: string; body: string }> = [],
): Promise<void> {
  doc.updatedAt = new Date().toISOString();
  for (const s of extraSections) setSection(doc, s.heading, s.body);
  const body = renderMarkdown(doc, doc.sections ?? []);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
}

function renderMarkdown(
  doc: MigrationDoc,
  humanSections: Array<{ heading: string; body: string }>,
): string {
  const phaseRows = (Object.keys(doc.phases) as PhaseId[])
    .map((id) => `| \`${id}\` | ${doc.phases[id].status} | ${doc.phases[id].finishedAt ?? ""} | ${doc.phases[id].notes ?? ""} |`)
    .join("\n");
  const human = humanSections
    .map((s) => `## ${s.heading}\n\n${s.body.trim()}\n`)
    .join("\n");
  return `# WordPress Migration

Generated and maintained by \`to-wordpress\`.

- Source: \`${doc.sourceDir}\`
- Created: ${doc.createdAt}
- Updated: ${doc.updatedAt}
${doc.copilotSessionId ? `- Copilot session: \`${doc.copilotSessionId}\`` : ""}

## Phases

| phase | status | finished | notes |
|---|---|---|---|
${phaseRows}

${human}

${MARKER_START}
${JSON.stringify(doc, null, 2)}
${MARKER_END}
`;
}

export function applyContextToDoc(doc: MigrationDoc, ctx: MigrationContext): MigrationDoc {
  if (ctx.detected) doc.detected = ctx.detected;
  if (ctx.choices) doc.choices = ctx.choices;
  if (ctx.copilotSessionId) doc.copilotSessionId = ctx.copilotSessionId;
  return doc;
}

export function markPhase(
  doc: MigrationDoc,
  id: PhaseId,
  status: "pending" | "running" | "ok" | "fail" | "skipped",
  notes?: string,
): void {
  const now = new Date().toISOString();
  const entry = doc.phases[id];
  if (status === "running") entry.startedAt = now;
  if (status === "ok" || status === "fail" || status === "skipped") entry.finishedAt = now;
  entry.status = status;
  if (notes) entry.notes = notes;
}
