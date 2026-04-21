import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { DetectedContext } from "../types.js";
import type { Detector } from "./types.js";
import { baseContext, listFiles, readCname } from "./common.js";

export const jekyllDetector: Detector = {
  name: "jekyll",
  priority: 100,

  async match(dir) {
    if (!existsSync(join(dir, "_config.yml")) && !existsSync(join(dir, "_config.toml"))) return 0;
    let score = 0.5;
    if (existsSync(join(dir, "_layouts"))) score += 0.2;
    if (existsSync(join(dir, "_includes"))) score += 0.1;
    if (
      existsSync(join(dir, "_posts")) ||
      existsSync(join(dir, "collections/_posts")) ||
      existsSync(join(dir, "_drafts"))
    )
      score += 0.2;
    if (existsSync(join(dir, "Gemfile"))) score += 0.1;
    return Math.min(1, score);
  },

  async detect(ctx, bus) {
    const dir = ctx.sourceDir;
    const out = baseContext(dir);
    out.kind = "jekyll";

    let config: Record<string, unknown> = {};
    try {
      const raw = await readFile(join(dir, "_config.yml"), "utf8");
      config = (parseYaml(raw) ?? {}) as Record<string, unknown>;
    } catch (err) {
      bus.pushStreamEvent("detect", {
        type: "warn",
        phase: "detect",
        message: `jekyll: failed to parse _config.yml: ${(err as Error).message}`,
      });
    }

    out.siteTitle = (config.title as string | undefined) ?? undefined;
    out.domain = (config.url as string | undefined) ?? (await readCname(dir));

    out.layouts = await listFiles(join(dir, "_layouts"), ".html");
    out.includes = await listFiles(join(dir, "_includes"), ".html");
    out.sassFiles = await listFiles(join(dir, "_sass"), ".scss");
    out.dataFiles = await listFiles(join(dir, "_data"));
    out.ssgPlugins = await listFiles(join(dir, "_plugins"), ".rb");
    if (existsSync(join(dir, "assets"))) out.assetsDirs.push(join(dir, "assets"));

    const collectionsDir = ((config.collections_dir as string | undefined) ?? "_").replace(/^\.\/?/, "");
    const collectionsRoot = join(dir, collectionsDir);
    const declared =
      (config.collections as Record<string, { output?: boolean; permalink?: string }> | undefined) ??
      { posts: { output: true, permalink: "/:path/" } };

    for (const [name, def] of Object.entries(declared)) {
      const possible = [join(collectionsRoot, `_${name}`), join(dir, `_${name}`), join(dir, name)];
      for (const p of possible) {
        if (existsSync(p)) {
          const mds = await listFiles(p, ".md");
          out.collections.push({ name, dir: p, permalink: def.permalink, count: mds.length });
          break;
        }
      }
    }
    if (existsSync(join(dir, "pages"))) {
      out.pages = await listFiles(join(dir, "pages"), ".md");
    }

    const fmKeys = new Set<string>();
    for (const coll of out.collections) {
      const sample = await listFiles(coll.dir, ".md");
      for (const f of sample.slice(0, 12)) {
        try {
          const raw = await readFile(f, "utf8");
          const m = raw.match(/^---\n([\s\S]*?)\n---/);
          if (m) {
            const fm = parseYaml(m[1]) as Record<string, unknown> | null;
            if (fm) for (const k of Object.keys(fm)) fmKeys.add(k);
          }
        } catch {
          /* ignore */
        }
      }
    }
    out.frontMatterKeys = [...fmKeys].sort();

    extractFeatures(config, out);

    return out;
  },
};

function extractFeatures(config: Record<string, unknown>, out: DetectedContext): void {
  const newsletter =
    (config.newsletter as Record<string, { form_action_url?: string }> | undefined) ?? {};
  out.features.newsletterFormAction = newsletter.mailchimp?.form_action_url;
  const comments =
    (config.comments as
      | Record<string, { shortname?: string; repo?: string; enabled?: boolean }>
      | undefined) ?? {};
  out.features.disqusShortname = comments.disqus?.shortname || undefined;
  out.features.giscusRepo = comments.giscus?.repo || undefined;
  out.features.commentoEnabled = Boolean(comments.commento?.enabled);
  const analytics = (config.analytics as Record<string, string> | undefined) ?? {};
  out.features.googleAnalyticsId = analytics.google_analytics_id || undefined;
  out.features.gtmId = analytics.gtm_id || undefined;
  out.features.plausibleDomain = analytics.plausible_data_domain || undefined;
  out.features.umamiWebsiteId = analytics.umami_data_website_id || undefined;
  const cookie = (config.cookie_banner as Record<string, boolean> | undefined) ?? {};
  out.features.cookieBanner = Boolean(cookie.enabled);
  const darkmode = (config.darkmode as Record<string, boolean> | undefined) ?? {};
  out.features.darkMode = Boolean(darkmode.enable_dark_mode);
  const og = (config.open_graph as Record<string, string> | undefined) ?? {};
  out.features.metaOpengraphType = og.meta_opengraph_type;
  out.features.twitterSite = og.meta_twitter_site;
  out.features.twitterCreator = og.meta_twitter_creator;
  out.colors = (config.colors as Record<string, string> | undefined) ?? undefined;
  out.fonts = (config.fonts as DetectedContext["fonts"]) ?? undefined;
}
