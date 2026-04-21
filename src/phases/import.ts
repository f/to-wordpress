import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, relative } from "node:path";
import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import type { MigrationContext } from "../types.js";
import type { UiBus } from "../tui/bus.js";
import { markdownToBlocks } from "./md2blocks.js";
import { wpCli } from "../wp/wpEnv.js";
import { WORK_MOUNT } from "../wp/wpEnv.js";

interface ImportEntry {
  post_type: string;
  title: string;
  slug: string;
  status: string;
  date: string;
  content: string;
  excerpt?: string;
  author_login?: string;
  author_email?: string;
  categories: string[];
  tags: string[];
  featured_image_rel?: string;
  layout?: string;
  meta: Record<string, string>;
}

export async function runImport(ctx: MigrationContext, bus: UiBus): Promise<void> {
  bus.pushStreamEvent("import", { type: "phase_start", phase: "import", message: "importing into WordPress" });
  const detected = ctx.detected;
  const choices = ctx.choices;
  if (!detected || !choices) throw new Error("plan phase must run before import");

  const indexPath = join(ctx.contentDir, "index.json");
  if (!existsSync(indexPath)) throw new Error("normalize phase must run before import");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    items: Array<{ postType: string; slug: string; path: string; originalPermalink: string; sourcePath: string }>;
  };

  bus.pushStreamEvent("import", { type: "info", phase: "import", message: `preparing ${index.items.length} items` });

  const entries: ImportEntry[] = [];
  for (const it of index.items) {
    const raw = await readFile(it.path, "utf8");
    const parsed = matter(raw);
    const content = markdownToBlocks(parsed.content);
    const rawTitle = String(parsed.data.title ?? it.slug);
    const featuredRel = (parsed.data.featured_image ?? parsed.data.image ?? parsed.data.thumbnail) as string | undefined;
    const layout = (parsed.data.layout as string | undefined) ?? undefined;
    entries.push({
      post_type: (parsed.data.post_type as string | undefined) ?? it.postType,
      title: rawTitle,
      slug: String(parsed.data.slug ?? it.slug),
      status: String(parsed.data.status ?? "publish"),
      date: String(parsed.data.date ?? new Date().toISOString()),
      content,
      excerpt: parsed.data.excerpt as string | undefined,
      author_login: parsed.data.author as string | undefined,
      author_email: undefined,
      categories: toStringArray(parsed.data.categories),
      tags: toStringArray(parsed.data.tags),
      featured_image_rel: featuredRel,
      layout,
      meta: {
        _wpify_original_permalink: String(parsed.data.original_permalink ?? ""),
        _wpify_source_path: String(parsed.data.source_path ?? ""),
        _wpify_title_html: rawTitle,
        ...(layout ? { _wpify_layout: layout } : {}),
      },
    });
  }

  const frontPageSlug = choices.frontPageSlug ?? findFrontPageSlug(index.items);
  const blogIndexPageSlug = choices.blogIndexPageSlug;
  const privacyPageSlug = choices.privacyPageSlug;
  const menuItems = await loadSourceMenu(ctx);

  const mediaFiles = existsSync(ctx.mediaDir)
    ? (await readdir(ctx.mediaDir)).map((f) => join(ctx.mediaDir, f))
    : [];

  const manifest = {
    theme_slug: detected.themeSlug,
    plugin_slug: detected.pluginSlug,
    site_title: detected.siteTitle ?? detected.themeSlug,
    domain: detected.domain ?? "",
    permalink_structure: choices.keepPermalinks ? derivePermalinkStructure(detected) : "/%postname%/",
    custom_post_types: choices.customPostTypes,
    work_mount: WORK_MOUNT,
    media_dir_relative: relative(ctx.workDir, ctx.mediaDir).replaceAll("\\", "/"),
    media: mediaFiles.map((f) => ({
      file: relative(ctx.workDir, f).replaceAll("\\", "/"),
      basename: basename(f),
    })),
    front_page_slug: frontPageSlug,
    blog_index_page_slug: blogIndexPageSlug,
    privacy_page_slug: privacyPageSlug,
    menu_items: menuItems,
    items: entries,
  };

  const manifestPath = join(ctx.workDir, "import-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  bus.pushStreamEvent("import", { type: "info", phase: "import", message: `wrote manifest ${relative(ctx.sourceDir, manifestPath)}` });

  const scriptPath = join(ctx.workDir, "import.php");
  await writeFile(scriptPath, buildImportPhp(), "utf8");

  bus.pushStreamEvent("import", { type: "info", phase: "import", message: "running wp eval-file import.php" });
  const res = await wpCli(
    [
      "eval-file",
      `${WORK_MOUNT}/import.php`,
      `${WORK_MOUNT}/import-manifest.json`,
      "--skip-themes",
      "--skip-plugins",
    ],
    {
      cwd: ctx.sourceDir,
      onLine: (line, stream) => {
        if (stream === "stderr") bus.pushStreamEvent("import", { type: "stderr", line });
        else bus.pushStreamEvent("import", { type: "info", phase: "import", message: line });
      },
      timeoutMs: 30 * 60 * 1000,
    },
  );
  if (res.exitCode !== 0) {
    bus.pushStreamEvent("import", { type: "phase_fail", phase: "import", message: `wp eval-file exited ${res.exitCode}` });
    throw new Error(`import failed: ${res.stderr.slice(0, 200)}`);
  }

  bus.pushStreamEvent("import", { type: "info", phase: "import", message: "activating theme and plugin, flushing rewrites" });
  await wpCli(["theme", "activate", detected.themeSlug], { cwd: ctx.sourceDir });
  await wpCli(["plugin", "activate", detected.pluginSlug], { cwd: ctx.sourceDir });
  await wpCli(["rewrite", "flush", "--hard"], { cwd: ctx.sourceDir });

  if (choices.createRedirects) {
    const redirects = buildRedirectsMap(index.items, choices, detected);
    await writeFile(join(ctx.workDir, "redirects.json"), JSON.stringify(redirects, null, 2) + "\n", "utf8");
    bus.pushStreamEvent("import", { type: "info", phase: "import", message: `wrote redirects.json (${Object.keys(redirects).length} entries)` });
  }

  bus.pushStreamEvent("import", { type: "phase_ok", phase: "import" });
}

function derivePermalinkStructure(detected: NonNullable<MigrationContext["detected"]>): string {
  const posts = detected.collections.find((c) => c.name === "posts");
  const tpl = posts?.permalink ?? "/:path/";
  return tpl
    .replace(/:path/g, "%postname%")
    .replace(/:slug/g, "%postname%")
    .replace(/:year/g, "%year%")
    .replace(/:month/g, "%monthnum%")
    .replace(/:day/g, "%day%")
    .replace(/:category/g, "%category%");
}

function buildRedirectsMap(
  items: Array<{ originalPermalink: string; slug: string; postType: string }>,
  choices: MigrationContext["choices"],
  detected: NonNullable<MigrationContext["detected"]>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const it of items) {
    const wpPath = derivePostPath(it, choices, detected);
    if (it.originalPermalink && wpPath && it.originalPermalink !== wpPath) {
      map[it.originalPermalink] = wpPath;
    }
  }
  return map;
}

function derivePostPath(
  it: { originalPermalink: string; slug: string; postType: string },
  choices: MigrationContext["choices"],
  detected: NonNullable<MigrationContext["detected"]>,
): string {
  if (choices?.keepPermalinks) return it.originalPermalink;
  if (it.postType === "page") return `/${it.slug}/`;
  const cpt = choices?.customPostTypes.find((c) => c.slug === it.postType);
  if (cpt) return `/${cpt.pathPrefix || cpt.slug}/${it.slug}/`;
  return `/${it.slug}/`;
}

function toStringArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(/[,;\s]+/).filter(Boolean);
  return [];
}

function findFrontPageSlug(
  items: Array<{ originalPermalink: string; slug: string; postType: string }>,
): string | undefined {
  const page = items.find(
    (it) => it.postType === "page" && (it.originalPermalink === "/" || it.originalPermalink === ""),
  );
  if (page) return page.slug;
  const homeSlug = items.find((it) => it.postType === "page" && /^home$/i.test(it.slug));
  return homeSlug?.slug;
}

interface SourceMenuItem {
  title: string;
  url: string;
  children?: SourceMenuItem[];
}

/**
 * Parse `_data/menu.yml` (or any detected data file named "menu") into a
 * normalized list of menu items the import runner can feed to
 * `wp_create_nav_menu`. Tries a few shapes seen in the wild:
 *   - flat list: `[{ title, url }, ...]`
 *   - keyed list under `primary: [...]`
 *   - nested with `items` / `children` arrays.
 */
async function loadSourceMenu(ctx: MigrationContext): Promise<SourceMenuItem[]> {
  const detected = ctx.detected;
  if (!detected) return [];
  const candidate = detected.dataFiles.find((f) => /menu\.(yml|yaml|json)$/i.test(f));
  if (!candidate) return [];
  try {
    const raw = await readFile(candidate, "utf8");
    const data = candidate.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    return flattenMenu(data);
  } catch {
    return [];
  }
}

function flattenMenu(data: unknown): SourceMenuItem[] {
  if (!data) return [];
  if (Array.isArray(data)) return data.map(toMenuItem).filter((x): x is SourceMenuItem => !!x);
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["primary", "main", "header", "top", "items", "menu"]) {
      if (Array.isArray(obj[key])) return flattenMenu(obj[key]);
    }
    const first = Object.values(obj).find((v) => Array.isArray(v));
    if (first) return flattenMenu(first);
  }
  return [];
}

function toMenuItem(v: unknown): SourceMenuItem | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const title =
    (o.title as string) ?? (o.label as string) ?? (o.name as string) ?? (o.text as string);
  const url =
    (o.url as string) ??
    (o.link as string) ??
    (o.href as string) ??
    (o.path as string) ??
    (o.permalink as string);
  if (!title || !url) return undefined;
  const childrenRaw = (o.children ?? o.items ?? o.submenu ?? o.dropdown) as unknown;
  const children = Array.isArray(childrenRaw) ? flattenMenu(childrenRaw) : undefined;
  return { title, url, children };
}

function buildImportPhp(): string {
  return `<?php
/**
 * Import manifest runner. Invoked via:
 *   wp eval-file wp-content/to-wordpress/import.php wp-content/to-wordpress/import-manifest.json
 * Runs entirely inside the wp-env container. Idempotent on slug + post_type.
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

$manifest_rel = isset( $args[0] ) ? $args[0] : 'wp-content/to-wordpress/import-manifest.json';
$manifest_path = ABSPATH . ltrim( $manifest_rel, '/' );
if ( ! file_exists( $manifest_path ) ) {
    WP_CLI::error( 'manifest not found: ' . $manifest_path );
}
$manifest = json_decode( file_get_contents( $manifest_path ), true );
if ( ! is_array( $manifest ) ) {
    WP_CLI::error( 'invalid manifest JSON' );
}

if ( ! empty( $manifest['site_title'] ) ) {
    update_option( 'blogname', $manifest['site_title'] );
}
if ( ! empty( $manifest['permalink_structure'] ) ) {
    update_option( 'permalink_structure', $manifest['permalink_structure'] );
}

require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';
require_once ABSPATH . 'wp-admin/includes/image.php';

$media_map = [];
$work_root = ABSPATH . trim( $manifest['work_mount'], '/' );
$media_dir = $work_root . '/' . trim( $manifest['media_dir_relative'], '/' );

foreach ( $manifest['media'] as $m ) {
    $source_file = $media_dir . '/' . $m['basename'];
    if ( ! file_exists( $source_file ) ) {
        WP_CLI::warning( 'missing media: ' . $source_file );
        continue;
    }
    $existing = get_posts( [
        'post_type'      => 'attachment',
        'meta_key'       => '_wpify_media_basename',
        'meta_value'     => $m['basename'],
        'posts_per_page' => 1,
        'fields'         => 'ids',
    ] );
    if ( ! empty( $existing ) ) {
        $media_map[ $m['basename'] ] = (int) $existing[0];
        continue;
    }

    $tmp = wp_tempnam( $m['basename'] );
    copy( $source_file, $tmp );
    $file_array = [
        'name'     => $m['basename'],
        'tmp_name' => $tmp,
    ];
    $attachment_id = media_handle_sideload( $file_array, 0 );
    if ( is_wp_error( $attachment_id ) ) {
        @unlink( $tmp );
        WP_CLI::warning( 'failed media: ' . $m['basename'] . ': ' . $attachment_id->get_error_message() );
        continue;
    }
    update_post_meta( $attachment_id, '_wpify_media_basename', $m['basename'] );
    $media_map[ $m['basename'] ] = (int) $attachment_id;
}

$user_map = [];
function wpify_ensure_user( $login, $email ) {
    if ( ! $login ) { return 0; }
    $user = get_user_by( 'login', $login );
    if ( $user ) { return (int) $user->ID; }
    $email = $email ?: ( $login . '@localhost.invalid' );
    $pw = wp_generate_password( 24, false );
    $uid = wp_insert_user( [
        'user_login'    => $login,
        'user_email'    => $email,
        'user_pass'     => $pw,
        'role'          => 'author',
        'display_name'  => $login,
    ] );
    return is_wp_error( $uid ) ? 0 : (int) $uid;
}

function wpify_ensure_terms( $names, $taxonomy ) {
    $ids = [];
    foreach ( $names as $name ) {
        $name = trim( (string) $name );
        if ( ! $name ) continue;
        $existing = term_exists( $name, $taxonomy );
        if ( $existing ) {
            $ids[] = (int) ( is_array( $existing ) ? $existing['term_id'] : $existing );
        } else {
            $new = wp_insert_term( $name, $taxonomy );
            if ( ! is_wp_error( $new ) ) { $ids[] = (int) $new['term_id']; }
        }
    }
    return $ids;
}

function wpify_rewrite_media_refs( $content, $media_map ) {
    return preg_replace_callback(
        '/media:([^)\\s"\\\']+)/',
        function ( $m ) use ( $media_map ) {
            $key = $m[1];
            if ( isset( $media_map[ $key ] ) ) {
                $url = wp_get_attachment_url( $media_map[ $key ] );
                return $url ?: $m[0];
            }
            return $m[0];
        },
        $content
    );
}

$created = 0;
$updated = 0;
foreach ( $manifest['items'] as $item ) {
    $post_type = isset( $item['post_type'] ) ? $item['post_type'] : 'post';
    $slug = sanitize_title( $item['slug'] );
    $existing = get_page_by_path( $slug, OBJECT, $post_type );
    $content = wpify_rewrite_media_refs( $item['content'], $media_map );
    $author_id = isset( $item['author_login'] ) ? wpify_ensure_user( $item['author_login'], $item['author_email'] ?? '' ) : 0;
    $data = [
        'post_type'    => $post_type,
        'post_title'   => $item['title'],
        'post_name'    => $slug,
        'post_status'  => $item['status'] ?: 'publish',
        'post_date'    => gmdate( 'Y-m-d H:i:s', strtotime( $item['date'] ) ),
        'post_date_gmt'=> gmdate( 'Y-m-d H:i:s', strtotime( $item['date'] ) ),
        'post_content' => $content,
        'post_excerpt' => $item['excerpt'] ?? '',
        'post_author'  => $author_id ?: 1,
    ];
    if ( $existing ) {
        $data['ID'] = $existing->ID;
        $post_id = wp_update_post( wp_slash( $data ), true );
        if ( ! is_wp_error( $post_id ) ) $updated++;
    } else {
        $post_id = wp_insert_post( wp_slash( $data ), true );
        if ( ! is_wp_error( $post_id ) ) $created++;
    }
    if ( is_wp_error( $post_id ) ) {
        WP_CLI::warning( 'post failed: ' . $item['slug'] . ': ' . $post_id->get_error_message() );
        continue;
    }
    if ( ! empty( $item['categories'] ) ) {
        $cat_ids = wpify_ensure_terms( $item['categories'], 'category' );
        wp_set_object_terms( $post_id, $cat_ids, 'category', false );
    }
    if ( ! empty( $item['tags'] ) ) {
        wp_set_object_terms( $post_id, $item['tags'], 'post_tag', false );
    }
    if ( ! empty( $item['meta'] ) ) {
        foreach ( $item['meta'] as $k => $v ) {
            update_post_meta( $post_id, $k, $v );
        }
    }
    if ( ! empty( $item['featured_image_rel'] ) ) {
        $base = basename( $item['featured_image_rel'] );
        $flat = str_replace( '/', '__', ltrim( $item['featured_image_rel'], '/' ) );
        if ( isset( $media_map[ $flat ] ) ) {
            set_post_thumbnail( $post_id, $media_map[ $flat ] );
        } elseif ( isset( $media_map[ $base ] ) ) {
            set_post_thumbnail( $post_id, $media_map[ $base ] );
        }
    }
}

// Configure the front page, blog index, and privacy policy from the manifest.
if ( ! empty( $manifest['front_page_slug'] ) ) {
    $home = get_page_by_path( sanitize_title( $manifest['front_page_slug'] ), OBJECT, 'page' );
    if ( $home ) {
        update_option( 'show_on_front', 'page' );
        update_option( 'page_on_front', (int) $home->ID );
        WP_CLI::log( 'front page set to: ' . $home->post_title . ' (#' . $home->ID . ')' );
    }
}

if ( ! empty( $manifest['blog_index_page_slug'] ) ) {
    $blog = get_page_by_path( sanitize_title( $manifest['blog_index_page_slug'] ), OBJECT, 'page' );
    if ( $blog ) {
        update_option( 'page_for_posts', (int) $blog->ID );
        WP_CLI::log( 'blog index set to: ' . $blog->post_title . ' (#' . $blog->ID . ')' );
    }
} elseif ( empty( $manifest['front_page_slug'] ) ) {
    update_option( 'page_for_posts', 0 );
}

if ( ! empty( $manifest['privacy_page_slug'] ) ) {
    $priv = get_page_by_path( sanitize_title( $manifest['privacy_page_slug'] ), OBJECT, 'page' );
    if ( $priv ) {
        update_option( 'wp_page_for_privacy_policy', (int) $priv->ID );
        WP_CLI::log( 'privacy policy set to: ' . $priv->post_title . ' (#' . $priv->ID . ')' );
    }
}

// For every page with a known source layout, point its _wp_page_template meta
// at the matching theme file so WordPress uses the custom template.
foreach ( $manifest['items'] as $it ) {
    if ( empty( $it['layout'] ) || ( $it['post_type'] ?? '' ) !== 'page' ) { continue; }
    $slug = sanitize_title( $it['slug'] );
    $page = get_page_by_path( $slug, OBJECT, 'page' );
    if ( ! $page ) { continue; }
    $layout = sanitize_title( $it['layout'] );
    $candidates = [ 'page-' . $layout . '.php', 'page-templates/' . $layout . '.php', 'template-' . $layout . '.php' ];
    $theme_dir = get_stylesheet_directory();
    $chosen = 'default';
    foreach ( $candidates as $c ) {
        if ( file_exists( $theme_dir . '/' . $c ) ) { $chosen = $c; break; }
    }
    if ( $chosen !== 'default' ) {
        update_post_meta( $page->ID, '_wp_page_template', $chosen );
    }
}

// Build a primary WordPress nav menu from the source menu.yml.
if ( ! empty( $manifest['menu_items'] ) && is_array( $manifest['menu_items'] ) ) {
    $menu_name = 'Primary';
    $menu = wp_get_nav_menu_object( $menu_name );
    if ( ! $menu ) {
        $menu_id = wp_create_nav_menu( $menu_name );
    } else {
        $menu_id = (int) $menu->term_id;
        // Clear existing items so re-runs are idempotent.
        $existing = wp_get_nav_menu_items( $menu_id );
        if ( is_array( $existing ) ) {
            foreach ( $existing as $mi ) { wp_delete_post( $mi->ID, true ); }
        }
    }
    if ( ! is_wp_error( $menu_id ) ) {
        $wpify_add_menu_items = function ( $items, $parent_id ) use ( $menu_id, &$wpify_add_menu_items ) {
            foreach ( $items as $item ) {
                $title = isset( $item['title'] ) ? (string) $item['title'] : '';
                $url = isset( $item['url'] ) ? (string) $item['url'] : '';
                if ( ! $title || ! $url ) continue;
                $new_id = wp_update_nav_menu_item( $menu_id, 0, [
                    'menu-item-title'  => $title,
                    'menu-item-url'    => home_url( $url ),
                    'menu-item-status' => 'publish',
                    'menu-item-parent-id' => $parent_id,
                ] );
                if ( ! is_wp_error( $new_id ) && ! empty( $item['children'] ) && is_array( $item['children'] ) ) {
                    $wpify_add_menu_items( $item['children'], (int) $new_id );
                }
            }
        };
        $wpify_add_menu_items( $manifest['menu_items'], 0 );
        $locations = get_theme_mod( 'nav_menu_locations' ) ?: [];
        $locations['primary'] = (int) $menu_id;
        set_theme_mod( 'nav_menu_locations', $locations );
        WP_CLI::log( 'primary menu populated with ' . count( $manifest['menu_items'] ) . ' top-level items' );
    }
}

flush_rewrite_rules( false );

WP_CLI::success( sprintf( 'import: %d created, %d updated, %d media', $created, $updated, count( $media_map ) ) );
`;
}
