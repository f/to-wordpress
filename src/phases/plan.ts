import type { MigrationContext, UserChoices } from "../types.js";
import { runCopilot } from "../copilot/run.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import {
  applyContextToDoc,
  loadMigrationDoc,
  markPhase,
  saveMigrationDoc,
} from "../state/migration.js";
import type { UiBus } from "../tui/bus.js";

export async function runPlan(ctx: MigrationContext, bus: UiBus): Promise<UserChoices> {
  bus.pushStreamEvent("plan", { type: "phase_start", phase: "plan", message: "asking URL-formatting questions" });

  const detected = ctx.detected;
  if (!detected) throw new Error("detect phase must run before plan");

  const keep = await bus.askPrompt({
    id: "plan.keepPermalinks",
    title: "Permalink mapping",
    kind: "select",
    message: buildKeepMessage(detected),
    options: [
      { label: "Keep source permalinks (recommended)", value: "keep" },
      { label: "Use default WordPress /%postname%/", value: "default" },
    ],
    default: "keep",
  });

  const cpts: UserChoices["customPostTypes"] = [];
  for (const coll of detected.collections) {
    if (coll.name === "posts") continue;
    const ans = await bus.askPrompt({
      id: `plan.cpt.${coll.name}`,
      title: `Custom post type: ${coll.name}`,
      kind: "select",
      message: `Source has a '${coll.name}' collection at ${coll.permalink ?? "(default)"} with ${coll.count} entries. Create a WordPress custom post type?`,
      options: [
        { label: `Yes, create CPT ${coll.name}`, value: "yes" },
        { label: "No, import as regular posts", value: "no" },
      ],
      default: "yes",
    });
    if (ans === "yes") {
      const prefix = inferPrefix(coll.permalink);
      cpts.push({ name: coll.name, slug: singular(coll.name), pathPrefix: prefix });
    }
  }

  const redirects = await bus.askPrompt({
    id: "plan.redirects",
    title: "Legacy URL redirects",
    kind: "select",
    message: "Create a redirects map (old path → new path) for any URL shape that changes?",
    options: [
      { label: "Yes, generate redirects.json", value: "yes" },
      { label: "No, skip", value: "no" },
    ],
    default: "yes",
  });

  const choices: UserChoices = {
    keepPermalinks: keep === "keep",
    customPostTypes: cpts,
    createRedirects: redirects === "yes",
    adminUser: "admin",
    adminPassword: "password",
    adminEmail: "admin@example.com",
  };
  ctx.choices = choices;

  bus.pushStreamEvent("plan", { type: "info", phase: "plan", message: "writing initial WORDPRESS_MIGRATION.md" });
  const doc = await loadMigrationDoc(ctx.planPath, ctx.sourceDir);
  applyContextToDoc(doc, ctx);
  markPhase(doc, "plan", "running");
  await saveMigrationDoc(ctx.planPath, doc, [
    {
      heading: "Overview",
      body: `Migration from ${detected.kind} to WordPress using wp-env. ${detected.collections.reduce((a, c) => a + c.count, 0)} posts, ${detected.pages.length} pages, ${detected.layouts.length} layouts detected.`,
    },
    {
      heading: "Detected context (summary)",
      body: summarizeDetected(detected),
    },
    {
      heading: "User choices",
      body: "```json\n" + JSON.stringify(choices, null, 2) + "\n```",
    },
  ]);

  if (!ctx.flags.skipCopilot) {
    bus.pushStreamEvent("plan", {
      type: "info",
      phase: "plan",
      message: "invoking copilot to enrich plan (this may take a minute)",
    });
    const tpl = await loadPrompt("plan");
    const prompt = interpolate(tpl, {
      SOURCE_DIR: ctx.sourceDir,
      KIND: detected.kind,
      DETECTED_JSON: JSON.stringify(detected, null, 2),
      CHOICES_JSON: JSON.stringify(choices, null, 2),
      PLAN_PATH: ctx.planPath,
    });

    let sessionId: string | undefined;
    try {
      const iter = runCopilot({
        prompt,
        cwd: ctx.sourceDir,
        addDirs: [ctx.sourceDir],
        mode: "autopilot",
        maxAutopilotContinues: 20,
        timeoutMs: 10 * 60 * 1000,
      });
      while (true) {
        const next = await iter.next();
        if (next.done) {
          sessionId = next.value.sessionId ?? sessionId;
          break;
        }
        bus.pushStreamEvent("plan", next.value);
        if (next.value.type === "session") sessionId = next.value.sessionId;
      }
    } catch (err) {
      bus.pushStreamEvent("plan", { type: "warn", phase: "plan", message: `copilot enrichment failed: ${(err as Error).message}` });
    }

    if (sessionId) ctx.copilotSessionId = sessionId;
  } else {
    bus.pushStreamEvent("plan", { type: "info", phase: "plan", message: "copilot skipped (--skip-copilot)" });
  }

  const doc2 = await loadMigrationDoc(ctx.planPath, ctx.sourceDir);
  applyContextToDoc(doc2, ctx);
  markPhase(doc2, "plan", "ok");
  await saveMigrationDoc(ctx.planPath, doc2, [
    {
      heading: "Overview",
      body: `Migration from ${detected.kind} to WordPress using wp-env. ${detected.collections.reduce((a, c) => a + c.count, 0)} posts, ${detected.pages.length} pages, ${detected.layouts.length} layouts detected.`,
    },
    {
      heading: "Detected context (summary)",
      body: summarizeDetected(detected),
    },
    {
      heading: "User choices",
      body: "```json\n" + JSON.stringify(choices, null, 2) + "\n```",
    },
  ]);

  bus.pushStreamEvent("plan", { type: "phase_ok", phase: "plan" });
  return choices;
}

function buildKeepMessage(d: { collections: Array<{ name: string; permalink?: string }> }): string {
  const first = d.collections[0];
  if (first && first.permalink) return `Source posts live at ${first.permalink}. Keep this URL shape in WordPress?`;
  return "Should WordPress mirror the source URL shape as closely as possible?";
}

function inferPrefix(permalink?: string): string {
  if (!permalink) return "";
  const m = permalink.match(/^\/([^/:]+)\//);
  return m ? m[1] : "";
}

function singular(name: string): string {
  if (name.endsWith("ies")) return name.slice(0, -3) + "y";
  if (name.endsWith("s")) return name.slice(0, -1);
  return name;
}

function summarizeDetected(d: {
  kind: string;
  domain?: string;
  siteTitle?: string;
  layouts: string[];
  includes: string[];
  collections: Array<{ name: string; count: number; permalink?: string }>;
  pages: string[];
  features: Record<string, unknown>;
}): string {
  const featureList = Object.entries(d.features)
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: \`${JSON.stringify(v)}\``)
    .join("\n");
  const collList = d.collections
    .map((c) => `- ${c.name} (${c.count} entries${c.permalink ? `, permalink ${c.permalink}` : ""})`)
    .join("\n");
  return [
    `- Kind: \`${d.kind}\``,
    `- Domain: ${d.domain ?? "(none)"}`,
    `- Site title: ${d.siteTitle ?? "(none)"}`,
    `- Layouts: ${d.layouts.length}, includes: ${d.includes.length}, pages: ${d.pages.length}`,
    `- Collections:\n${collList || "  (none)"}`,
    `- Features:\n${featureList || "  (none)"}`,
  ].join("\n");
}
