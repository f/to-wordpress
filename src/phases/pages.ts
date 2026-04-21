import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import matter from "gray-matter";
import type { DetectedContext, PageSummary } from "../types.js";

/**
 * Inspect every `detected.pages` entry, read its front-matter, and produce a
 * summary that includes a best-guess role (front / blog-index / privacy /
 * terms / contact / archive). Import will later use these roles to wire
 * `show_on_front`, `page_on_front`, `page_for_posts`, and
 * `wp_page_for_privacy_policy` in WordPress.
 */
export async function analyzePages(detected: DetectedContext): Promise<PageSummary[]> {
  const out: PageSummary[] = [];
  for (const path of detected.pages) {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = matter(raw);
      const fmSlug = typeof parsed.data.slug === "string" ? parsed.data.slug : undefined;
      const fmTitle = typeof parsed.data.title === "string" ? parsed.data.title : undefined;
      const fmPerm = typeof parsed.data.permalink === "string" ? parsed.data.permalink : undefined;
      const fmLayout = typeof parsed.data.layout === "string" ? parsed.data.layout : undefined;
      const baseSlug = basename(path, extname(path));
      const slug = fmSlug ?? slugify(baseSlug);
      const title = fmTitle ?? humanize(slug);
      out.push({
        sourcePath: path,
        slug,
        title,
        permalink: fmPerm,
        layout: fmLayout,
      });
    } catch {
      /* ignore unreadable pages */
    }
  }
  assignRoles(out);
  return out;
}

function assignRoles(pages: PageSummary[]): void {
  const by = {
    byPerm: (re: RegExp) => pages.find((p) => p.permalink && re.test(p.permalink)),
    bySlug: (re: RegExp) => pages.find((p) => re.test(p.slug)),
    byTitle: (re: RegExp) => pages.find((p) => re.test(p.title)),
  };

  const front = by.byPerm(/^\/?$/) ?? by.bySlug(/^(home|index|front)$/i);
  if (front) front.role = "front";

  const blog = by.byPerm(/^\/blog\/?$/i) ?? by.bySlug(/^blog(-index)?$/i) ?? by.byTitle(/^blog$/i);
  if (blog && blog !== front) blog.role = "blog-index";

  const privacy = by.bySlug(/privacy/i) ?? by.byTitle(/privacy/i);
  if (privacy && !privacy.role) privacy.role = "privacy";

  const terms = by.bySlug(/^(terms|tos|legal)$/i);
  if (terms && !terms.role) terms.role = "terms";

  const contact = by.bySlug(/^contact(-us)?$/i);
  if (contact && !contact.role) contact.role = "contact";

  const archive = by.bySlug(/^(categories|tags|archive)$/i);
  if (archive && !archive.role) archive.role = "archive";

  for (const p of pages) if (!p.role) p.role = "none";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function humanize(s: string): string {
  return s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
