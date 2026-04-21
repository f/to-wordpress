import type { MigrationContext, PhaseId, PhaseStatus } from "../types.js";

/**
 * Per-phase base cost and per-item multipliers, in seconds. These numbers
 * are anchored on real runs (f.github.io: 42 posts + 4 pages + 13 layouts +
 * 60 includes measured ~24 minutes end-to-end) and can drift as the tool
 * improves — they only need to be directionally correct for the user-facing
 * countdown to feel honest.
 */
const BASE_SECONDS: Record<PhaseId, number> = {
  detect: 5,
  plan: 120,
  boot: 120,
  theme: 240,
  plugin: 180,
  normalize: 3,
  import: 30,
  verify: 25,
  fix: 90,
};

const PER_ITEM = {
  themePerLayout: 10,
  themePerInclude: 4,
  pluginPerFeature: 15,
  pluginPerCpt: 30,
  normalizePerItem: 0.2,
  importPerPost: 0.6,
  importPerMedia: 1.5,
  verifyPerUrl: 1.5,
};

/** Budget per phase in seconds, based on the detected inventory + user choices. */
export function computePhaseBudgets(ctx: MigrationContext): Record<PhaseId, number> {
  const d = ctx.detected;
  const c = ctx.choices;
  const flags = ctx.flags;

  const layouts = d?.layouts.length ?? 0;
  const includes = d?.includes.length ?? 0;
  const posts = d?.collections.reduce((a, cl) => a + cl.count, 0) ?? 0;
  const pages = d?.pages.length ?? 0;
  const items = posts + pages;
  const features = d ? Object.values(d.features).filter(Boolean).length : 0;
  const cpts = c?.customPostTypes.length ?? 0;

  // Verify samples up to 20 URLs by design.
  const verifyUrls = Math.min(20, items);

  const themeCost = BASE_SECONDS.theme + layouts * PER_ITEM.themePerLayout + includes * PER_ITEM.themePerInclude;
  const pluginCost = BASE_SECONDS.plugin + features * PER_ITEM.pluginPerFeature + cpts * PER_ITEM.pluginPerCpt;
  const normCost = BASE_SECONDS.normalize + items * PER_ITEM.normalizePerItem;
  const importCost = BASE_SECONDS.import + items * PER_ITEM.importPerPost + /* media approx */ Math.min(items, 200) * PER_ITEM.importPerMedia;
  const verifyCost = BASE_SECONDS.verify + verifyUrls * PER_ITEM.verifyPerUrl;

  const budgets: Record<PhaseId, number> = {
    detect: BASE_SECONDS.detect,
    plan: flags.skipCopilot ? 5 : BASE_SECONDS.plan,
    boot: flags.skipBoot ? 0 : BASE_SECONDS.boot,
    theme: flags.skipCopilot ? 5 : themeCost,
    plugin: flags.skipCopilot ? 5 : pluginCost,
    normalize: normCost,
    import: flags.skipBoot ? 0 : importCost,
    verify: flags.skipBoot ? 0 : verifyCost,
    fix: flags.skipCopilot ? 0 : BASE_SECONDS.fix,
  };
  return budgets;
}

export function sumBudgets(budgets: Record<PhaseId, number>): number {
  return Object.values(budgets).reduce((a, b) => a + b, 0);
}

export interface EtaSnapshot {
  totalSeconds: number;
  remainingSeconds: number;
  budgets: Record<PhaseId, number>;
  completed: PhaseId[];
  active?: PhaseId;
}

/**
 * Compute total + remaining seconds given the current phase status map.
 * "Completed" = phases whose status is ok / fail / skipped. "Active" = the
 * first phase still running. Remaining = active + pending phases.
 */
export function computeEta(
  ctx: MigrationContext,
  statuses: Partial<Record<PhaseId, PhaseStatus>>,
): EtaSnapshot {
  const budgets = computePhaseBudgets(ctx);
  const order: PhaseId[] = [
    "detect",
    "plan",
    "boot",
    "theme",
    "plugin",
    "normalize",
    "import",
    "verify",
    "fix",
  ];
  const completed: PhaseId[] = [];
  let active: PhaseId | undefined;
  let remaining = 0;
  for (const id of order) {
    const st = statuses[id];
    if (st === "ok" || st === "fail" || st === "skipped") {
      completed.push(id);
      continue;
    }
    if (st === "running" && !active) active = id;
    remaining += budgets[id];
  }
  return {
    totalSeconds: sumBudgets(budgets),
    remainingSeconds: remaining,
    budgets,
    completed,
    active,
  };
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "<1m";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `~${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `~${h}h` : `~${h}h ${m}m`;
}
