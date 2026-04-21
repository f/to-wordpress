import { wpCli } from "./wpEnv.js";

export interface WpCliCtx {
  cwd: string;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
}

export async function setPermalinkStructure(ctx: WpCliCtx, structure: string): Promise<void> {
  await wpCli(["option", "update", "permalink_structure", structure], ctx);
  await wpCli(["rewrite", "flush", "--hard"], ctx);
}

export async function setOption(ctx: WpCliCtx, name: string, value: string): Promise<void> {
  await wpCli(["option", "update", name, value], ctx);
}

export async function mediaImport(ctx: WpCliCtx, filePath: string, title?: string): Promise<number | undefined> {
  const args = ["media", "import", filePath, "--porcelain"];
  if (title) args.push("--title", title);
  const res = await wpCli(args, ctx);
  const id = Number(res.stdout.trim());
  return Number.isFinite(id) && id > 0 ? id : undefined;
}

export interface CreatePostInput {
  postType: string;
  title: string;
  slug: string;
  status: string;
  date?: string;
  content: string;
  excerpt?: string;
  authorId?: number;
  featuredMediaId?: number;
  meta?: Record<string, string>;
  categories?: number[];
  tags?: number[];
}

export async function createPost(ctx: WpCliCtx, input: CreatePostInput): Promise<number | undefined> {
  const args = [
    "post",
    "create",
    "--porcelain",
    `--post_type=${input.postType}`,
    `--post_title=${input.title}`,
    `--post_name=${input.slug}`,
    `--post_status=${input.status}`,
  ];
  if (input.date) args.push(`--post_date=${input.date}`);
  if (input.excerpt) args.push(`--post_excerpt=${input.excerpt}`);
  if (input.authorId) args.push(`--post_author=${input.authorId}`);
  const res = await wpCli([...args, "-"], {
    ...ctx,
  });
  const id = Number(res.stdout.trim());
  if (!Number.isFinite(id) || id <= 0) return undefined;

  if (input.featuredMediaId) {
    await wpCli(["post", "meta", "update", String(id), "_thumbnail_id", String(input.featuredMediaId)], ctx);
  }
  if (input.meta) {
    for (const [k, v] of Object.entries(input.meta)) {
      await wpCli(["post", "meta", "update", String(id), k, v], ctx);
    }
  }
  if (input.categories && input.categories.length > 0) {
    await wpCli(["post", "term", "set", String(id), "category", ...input.categories.map(String)], ctx);
  }
  if (input.tags && input.tags.length > 0) {
    await wpCli(["post", "term", "set", String(id), "post_tag", ...input.tags.map(String)], ctx);
  }
  return id;
}

export async function ensureTerm(
  ctx: WpCliCtx,
  taxonomy: string,
  name: string,
  slug?: string,
): Promise<number | undefined> {
  const listArgs = ["term", "list", taxonomy, "--field=term_id", `--slug=${slug ?? slugify(name)}`];
  const res = await wpCli(listArgs, ctx);
  const existing = Number(res.stdout.trim().split("\n")[0]);
  if (Number.isFinite(existing) && existing > 0) return existing;
  const createArgs = ["term", "create", taxonomy, name, "--porcelain"];
  if (slug) createArgs.push(`--slug=${slug}`);
  const created = await wpCli(createArgs, ctx);
  const id = Number(created.stdout.trim());
  return Number.isFinite(id) && id > 0 ? id : undefined;
}

export async function ensureUser(
  ctx: WpCliCtx,
  login: string,
  email: string,
  displayName?: string,
  role = "author",
): Promise<number | undefined> {
  const list = await wpCli(["user", "get", login, "--field=ID"], ctx);
  const existing = Number(list.stdout.trim());
  if (Number.isFinite(existing) && existing > 0) return existing;
  const args = ["user", "create", login, email, `--role=${role}`, "--porcelain"];
  if (displayName) args.push(`--display_name=${displayName}`);
  const created = await wpCli(args, ctx);
  const id = Number(created.stdout.trim());
  return Number.isFinite(id) && id > 0 ? id : undefined;
}

export async function registerMenu(ctx: WpCliCtx, name: string, slug: string): Promise<void> {
  await wpCli(["menu", "create", name, `--slug=${slug}`], ctx);
}

export async function addMenuItem(
  ctx: WpCliCtx,
  menuSlug: string,
  title: string,
  url: string,
): Promise<void> {
  await wpCli(["menu", "item", "add-custom", menuSlug, title, url], ctx);
}

export async function activateTheme(ctx: WpCliCtx, slug: string): Promise<void> {
  await wpCli(["theme", "activate", slug], ctx);
}

export async function activatePlugin(ctx: WpCliCtx, slug: string): Promise<void> {
  await wpCli(["plugin", "activate", slug], ctx);
}

export async function countPostsByType(ctx: WpCliCtx, postType: string): Promise<number> {
  const res = await wpCli(
    ["post", "list", `--post_type=${postType}`, "--post_status=publish", "--format=count"],
    ctx,
  );
  return Number(res.stdout.trim()) || 0;
}

export async function getSiteUrl(ctx: WpCliCtx): Promise<string> {
  const res = await wpCli(["option", "get", "siteurl"], ctx);
  return res.stdout.trim();
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
