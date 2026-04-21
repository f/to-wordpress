import type { z } from "zod";

export type PhaseId =
  | "detect"
  | "plan"
  | "boot"
  | "theme"
  | "plugin"
  | "normalize"
  | "import"
  | "verify"
  | "fix";

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
  | "jekyll"
  | "hugo"
  | "eleventy"
  | "ghost-export"
  | "gatsby"
  | "next"
  | "plain-html"
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
}

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

export interface PhaseEvent {
  type: "phase_start" | "phase_ok" | "phase_fail" | "info" | "warn";
  phase: PhaseId;
  message?: string;
}

export type StreamEvent = CopilotEvent | PhaseEvent;

export type ZodSchema<T> = z.ZodType<T>;
