import type { MigrationContext, PageSummary, UserChoices } from "../types.js";
import { runCopilot } from "../agents/index.js";
import { interpolate, loadPrompt } from "../prompts/index.js";
import {
  applyContextToDoc,
  loadMigrationDoc,
  markPhase,
  saveMigrationDoc,
} from "../state/migration.js";
import type { UiBus } from "../tui/bus.js";
import { analyzePages } from "./pages.js";

/**
 * Plan phase. Fully parametric — all decisions come from CLI flags
 * (ctx.planOverrides) or auto-detection. Never prompts the user.
 */
export async function runPlan(ctx: MigrationContext, bus: UiBus): Promise<UserChoices> {
  bus.pushStreamEvent("plan", { type: "phase_start", phase: "plan", message: "sketching stanzas — deriving the migration plan" });

  const detected = ctx.detected;
  if (!detected) throw new Error("detect phase must run before plan");

  const ov = ctx.planOverrides ?? {};

  const keepPermalinks = (ov.permalinks ?? "keep") === "keep";
  bus.pushStreamEvent("plan", {
    type: "info",
    phase: "plan",
    message: `permalinks: ${keepPermalinks ? "keep source URLs" : "default /%postname%/"}`,
  });

  const cptMode = ov.cpts ?? "all";
  const cpts: UserChoices["customPostTypes"] = [];
  for (const coll of detected.collections) {
    if (coll.name === "posts") continue;
    if (cptMode === "all") {
      const prefix = inferPrefix(coll.permalink);
      cpts.push({ name: coll.name, slug: singular(coll.name), pathPrefix: prefix });
    }
  }
  if (cpts.length > 0) {
    bus.pushStreamEvent("plan", {
      type: "info",
      phase: "plan",
      message: `custom post types: ${cpts.map((c) => c.slug).join(", ")}`,
    });
  }

  const createRedirects = ov.redirects !== false;

  const pages = await analyzePages(detected);
  if (pages.length > 0) {
    bus.pushStreamEvent("plan", {
      type: "info",
      phase: "plan",
      message: `pages: ${pages.length} detected — ${pages.map((p) => `${p.slug}${p.role && p.role !== "none" ? "(" + p.role + ")" : ""}`).join(", ")}`,
    });
  }

  const frontPageSlug =
    ov.frontPage ?? pages.find((p) => p.role === "front")?.slug;
  const blogIndexPageSlug =
    ov.blogIndex ?? pages.find((p) => p.role === "blog-index")?.slug;
  const privacyPageSlug =
    ov.privacyPage ?? pages.find((p) => p.role === "privacy")?.slug;

  const choices: UserChoices = {
    keepPermalinks,
    customPostTypes: cpts,
    createRedirects,
    frontPageSlug,
    blogIndexPageSlug,
    privacyPageSlug,
    pages,
    adminUser: ov.adminUser ?? "admin",
    adminPassword: ov.adminPassword ?? "password",
    adminEmail: ov.adminEmail ?? "admin@example.com",
  };
  ctx.choices = choices;

  bus.pushStreamEvent("plan", {
    type: "info",
    phase: "plan",
    message: `page wiring: front=${choices.frontPageSlug ?? "-"} blog=${choices.blogIndexPageSlug ?? "-"} privacy=${choices.privacyPageSlug ?? "-"}`,
  });

  bus.pushStreamEvent("plan", { type: "info", phase: "plan", message: "writing initial WORDPRESS_MIGRATION.md" });
  const doc = await loadMigrationDoc(ctx.planPath, ctx.sourceDir);
  applyContextToDoc(doc, ctx);
  markPhase(doc, "plan", "running");
  const sections = buildSections(detected, pages, choices);
  await saveMigrationDoc(ctx.planPath, doc, sections);

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
      DETECTOR_BRIEFING: detected.detectorBriefing ?? "(no detector briefing)",
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
  await saveMigrationDoc(ctx.planPath, doc2, sections);

  bus.pushStreamEvent("plan", { type: "phase_ok", phase: "plan" });
  return choices;
}

function buildSections(
  detected: NonNullable<MigrationContext["detected"]>,
  pages: PageSummary[],
  choices: UserChoices,
): Array<{ heading: string; body: string }> {
  return [
    {
      heading: "Overview",
      body: `Migration from ${detected.kind} to WordPress using wp-env. ${detected.collections.reduce((a, c) => a + c.count, 0)} posts, ${detected.pages.length} pages, ${detected.layouts.length} layouts detected.`,
    },
    {
      heading: "Detected context (summary)",
      body: summarizeDetected(detected),
    },
    {
      heading: "Static pages",
      body: summarizePages(pages),
    },
    {
      heading: "User choices",
      body: "```json\n" + JSON.stringify(choices, null, 2) + "\n```",
    },
  ];
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

function summarizePages(pages: PageSummary[]): string {
  if (pages.length === 0) return "_No standalone pages detected._";
  const rows = pages
    .map(
      (p) =>
        `| \`${p.slug}\` | ${p.title} | ${p.permalink ?? "-"} | ${p.layout ?? "-"} | ${p.role ?? "-"} |`,
    )
    .join("\n");
  return [
    "| slug | title | permalink | layout | role |",
    "|---|---|---|---|---|",
    rows,
  ].join("\n");
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
