import type { z } from "zod";

export type PhaseId =
  | "detect"
  | "plan"
  | "boot"
  | "theme"
  | "normalize"
  | "blockify"
  | "plugin"
  | "import"
  | "verify"
  | "fix"
  | "testfix";

export type PhaseStatus = "pending" | "running" | "ok" | "fail" | "skipped";

export interface PhaseState {
  id: PhaseId;
  title: string;
  status: PhaseStatus;
  startedAt?: number;
  finishedAt?: number;
  message?: string;
}

export type SsgKind =
  // Classic SSGs
  | "jekyll"
  | "hugo"
  | "eleventy"
  | "gatsby"
  | "next"
  | "hexo"
  | "astro"
  // Documentation frameworks
  | "docusaurus"
  | "mkdocs"
  // CMS / platform exports
  | "ghost-export"
  | "wp-wxr"
  | "medium-export"
  | "substack-export"
  // Raw content formats (any text-like dump)
  | "plain-html"
  | "markdown-folder"
  | "docx-folder"
  | "xlsx-sheet"
  | "pdf-folder"
  | "text-folder"
  | "epub-book"
  // Code repositories (README-driven landing pages)
  | "github-repo"
  // Fallback — freestyle detector takes over
  | "unknown";

export interface DetectedContext {
  sourceDir: string;
  kind: SsgKind;
  domain?: string;
  siteTitle?: string;
  themeSlug: string;
  pluginSlug: string;
  layouts: string[];
  includes: string[];
  sassFiles: string[];
  assetsDirs: string[];
  dataFiles: string[];
  ssgPlugins: string[];
  collections: Array<{
    name: string;
    dir: string;
    permalink?: string;
    count: number;
  }>;
  pages: string[];
  frontMatterKeys: string[];
  features: {
    newsletterFormAction?: string;
    giscusRepo?: string;
    disqusShortname?: string;
    commentoEnabled?: boolean;
    googleAnalyticsId?: string;
    gtmId?: string;
    plausibleDomain?: string;
    umamiWebsiteId?: string;
    cookieBanner?: boolean;
    darkMode?: boolean;
    metaOpengraphType?: string;
    twitterSite?: string;
    twitterCreator?: string;
  };
  colors?: Record<string, string>;
  fonts?: {
    useGoogleFonts?: boolean;
    googleFontsUrl?: string;
    heading?: string;
    base?: string;
    monospace?: string;
    logo?: string;
  };
  /**
   * Non-markdown source files the detector decided are content. The
   * normalize phase passes each entry through a format-specific Copilot
   * prompt (see `src/prompts/convert-*.md`) to produce a canonical
   * markdown file before running the standard normalization flow.
   *
   * Leave empty (`[]`) for detectors whose sources are already
   * markdown/HTML friendly.
   */
  rawSources?: Array<{
    path: string;
    /** The `convert-<format>.md` prompt to use. */
    format: RawSourceFormat;
    /** Optional hint passed through to the prompt. */
    hint?: string;
    /** Default post type for items coming from this source. */
    postType?: string;
  }>;
  /**
   * Source code of SSG plugins/hooks (e.g. Jekyll `_plugins/*.rb`).
   * Keyed by filename, value is the full source. The plugin phase uses
   * these to understand and replicate custom generators, endpoints,
   * and build-time behavior in WordPress.
   */
  ssgPluginSources?: Record<string, string>;
  /**
   * Free-form human guidance the detector wants to pass through to every
   * Copilot-driven phase (theme, plugin, normalize conversion, verify,
   * fix). Kept short — one paragraph max. E.g. "this is a GitHub repo's
   * README; produce a SaaS landing page with feature grid + install CTA."
   */
  detectorBriefing?: string;
}

/**
 * Every format that to-wordpress can ingest. The format decides which
 * `convert-<format>.md` prompt is used to turn the raw file(s) into the
 * canonical markdown that the normalize phase then imports.
 */
export type RawSourceFormat =
  | "docx"
  | "xlsx"
  | "csv"
  | "pdf"
  | "epub"
  | "txt"
  | "html"
  | "wxr"
  | "medium-html"
  | "substack"
  | "readme";

export interface PageSummary {
  sourcePath: string;
  slug: string;
  title: string;
  permalink?: string;
  layout?: string;
  role?: "front" | "blog-index" | "privacy" | "terms" | "contact" | "archive" | "none";
}

export interface UserChoices {
  keepPermalinks: boolean;
  customPostTypes: Array<{
    name: string;
    slug: string;
    pathPrefix: string;
  }>;
  createRedirects: boolean;
  frontPageSlug?: string;
  blogIndexPageSlug?: string;
  privacyPageSlug?: string;
  pages?: PageSummary[];
  adminUser: string;
  adminPassword: string;
  adminEmail: string;
}

export interface MigrationFlags {
  skipCopilot?: boolean;
  skipBoot?: boolean;
  yes?: boolean;
  fresh?: boolean;
}

/**
 * CLI-provided overrides for plan-phase decisions. Every field has a
 * sensible auto-detected default so nothing is ever interactive.
 */
export interface PlanOverrides {
  permalinks?: "keep" | "default";
  cpts?: "all" | "none";
  redirects?: boolean;
  frontPage?: string;
  blogIndex?: string;
  privacyPage?: string;
  adminUser?: string;
  adminPassword?: string;
  adminEmail?: string;
}

export interface MigrationContext {
  sourceDir: string;
  workDir: string;
  planPath: string;
  wpEnvConfigPath: string;
  themeDir: string;
  pluginDir: string;
  contentDir: string;
  mediaDir: string;
  detected?: DetectedContext;
  choices?: UserChoices;
  copilotSessionId?: string;
  wpUrl?: string;
  flags: MigrationFlags;
  planOverrides?: PlanOverrides;
  /**
   * Set of unknown Liquid shortcode names ({@link normalize.ts}) encountered
   * during normalization. The plugin phase reads this to generate matching
   * WordPress shortcode handlers so no raw Liquid survives in the imported
   * content.
   */
  shortcodes?: Set<string>;
}

export type CopilotEvent =
  | { type: "stdout"; line: string; raw?: unknown }
  | { type: "stderr"; line: string }
  | { type: "message"; role: "assistant" | "user" | "system"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_use"; name: string; input?: unknown; id?: string }
  | { type: "tool_result"; name?: string; output?: unknown; id?: string; isError?: boolean }
  | { type: "error"; message: string }
  | { type: "session"; sessionId: string }
  | { type: "done"; exitCode: number };

export type LoopStage = "attempting" | "testing" | "fixing" | "repairing";

export interface PhaseEvent {
  type: "phase_start" | "phase_ok" | "phase_fail" | "info" | "warn";
  phase: PhaseId;
  message?: string;
}

export interface LoopStatusEvent {
  type: "loop_status";
  phase: PhaseId;
  attempt: number;
  maxAttempts: number;
  fixPass: number;
  maxFixPasses: number;
  stage: LoopStage;
}

export type StreamEvent = CopilotEvent | PhaseEvent | LoopStatusEvent;

export type ZodSchema<T> = z.ZodType<T>;
