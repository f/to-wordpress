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

/**
 * Run a wp-cli command and log its failure through the bus without
 * throwing. Used for side-effect calls (theme/plugin activation,
 * rewrite flush) where a non-zero exit isn't fatal — the import
 * itself already handles the important work.
 */
async function wpCliSoft(
  args: string[],
  opts: Parameters<typeof wpCli>[1],
  bus: UiBus,
): Promise<void> {
  try {
    const r = await wpCli(args, opts);
    if (r.exitCode !== 0) {
      bus.pushStreamEvent("import", {
        type: "warn",
        phase: "import",
        message: `wp ${args.join(" ")} exited ${r.exitCode}: ${(r.stderr || "").split("\n")[0] || ""}`,
      });
    }
  } catch (err) {
    bus.pushStreamEvent("import", {
      type: "warn",
      phase: "import",
      message: `wp ${args.join(" ")} errored: ${(err as Error).message}`,
    });
  }
}

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
  bus.pushStreamEvent("import", { type: "phase_start", phase: "import", message: "binding the manuscript — setting every page and post in WordPress" });
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
        _towp_original_permalink: String(parsed.data.original_permalink ?? ""),
        _towp_source_path: String(parsed.data.source_path ?? ""),
        _towp_title_html: rawTitle,
        ...(layout ? { _towp_layout: layout } : {}),
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

  // Activate the freshly generated theme + plugin BEFORE running the
  // import script so the plugin's custom post types and shortcodes are
  // already registered by the time wp_insert_post() tries to use them.
  // Without this, CPT items silently fail validation and any shortcode
  // rendered during post-save hooks is a no-op.
  bus.pushStreamEvent("import", { type: "info", phase: "import", message: "activating theme + plugin so CPTs and shortcodes are live during import" });
  await wpCliSoft(["theme", "activate", detected.themeSlug], { cwd: ctx.sourceDir }, bus);
  await wpCliSoft(["plugin", "activate", detected.pluginSlug], { cwd: ctx.sourceDir }, bus);

  bus.pushStreamEvent("import", { type: "info", phase: "import", message: "running wp eval-file import.php" });
  const res = await wpCli(
    [
      "eval-file",
      `${WORK_MOUNT}/import.php`,
      `${WORK_MOUNT}/import-manifest.json`,
      // We intentionally do NOT pass --skip-themes/--skip-plugins: the
      // theme + plugin we just activated must be loaded so custom post
      // types, taxonomies, shortcodes, and template paths resolve.
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
    // Surface the last few lines of stderr so the user sees WHY it died
    // instead of just the exit code. Many PHP fatals only reveal their
    // cause in stderr.
    const tail = (res.stderr || "").split(/\r?\n/).filter(Boolean).slice(-10).join(" | ");
    bus.pushStreamEvent("import", {
      type: "phase_fail",
      phase: "import",
      message: `wp eval-file exited ${res.exitCode}${tail ? ` — ${tail}` : ""}`,
    });
    throw new Error(`import failed (exit ${res.exitCode}): ${tail || res.stderr.slice(0, 400)}`);
  }

  bus.pushStreamEvent("import", { type: "info", phase: "import", message: "flushing rewrite rules" });
  await wpCliSoft(["rewrite", "flush", "--hard"], { cwd: ctx.sourceDir }, bus);

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
 * Runs entirely inside the wp-env container. Idempotent on slug + post_type
 * and designed to NEVER crash-exit when one item fails: every per-item
 * operation is wrapped in try/catch so partial imports still produce a
 * usable site, and the caller sees a clear list of failures.
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

// Give ourselves headroom — migrating 100+ posts with sideloaded media
// routinely exceeds PHP's default 30-second limit and 128 MB memory.
@set_time_limit( 0 );
@ini_set( 'memory_limit', '512M' );

// If anything below raises a fatal, at least say WHICH item we were on
// instead of the user seeing an opaque "Allowed memory size exhausted".
$GLOBALS['towp_current_item'] = null;
register_shutdown_function( function () {
    $err = error_get_last();
    if ( $err && in_array( $err['type'], [ E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR ], true ) ) {
        $slug = $GLOBALS['towp_current_item']['slug'] ?? '?';
        $type = $GLOBALS['towp_current_item']['post_type'] ?? '?';
        fwrite( STDERR, "\\ntowp FATAL while importing {$type} \\"{$slug}\\": {$err['message']} at {$err['file']}:{$err['line']}\\n" );
    }
} );

// Centralized per-item exception wrapper. Keeps the loop alive so one
// bad post doesn't lose the other 99.
$towp_failures = [];
function towp_try( $label, callable $fn ) {
    global $towp_failures;
    try {
        return $fn();
    } catch ( \\Throwable $e ) {
        $towp_failures[] = $label . ': ' . $e->getMessage();
        WP_CLI::warning( $label . ': ' . $e->getMessage() );
        return null;
    }
}

// ── Preset cleanup ────────────────────────────────────────────────────
// Strip WordPress's default content so the migrated site is a faithful
// replica of the source. Only touches well-known preset slugs; anything
// the user or a previous run created stays put.
towp_try( 'preset cleanup', function () {
    $preset_slugs = [ 'hello-world', 'sample-page', 'privacy-policy' ];
    foreach ( $preset_slugs as $s ) {
        foreach ( [ 'post', 'page' ] as $t ) {
            $p = get_page_by_path( $s, OBJECT, $t );
            if ( $p ) { wp_delete_post( $p->ID, true ); }
        }
    }
    $autodrafts = get_posts( [
        'post_status'    => 'auto-draft',
        'posts_per_page' => -1,
        'post_type'      => [ 'post', 'page' ],
        'fields'         => 'ids',
    ] );
    foreach ( $autodrafts as $id ) { wp_delete_post( $id, true ); }
    global $wpdb;
    $wpdb->query( "DELETE FROM {$wpdb->comments} WHERE comment_author = 'A WordPress Commenter' AND comment_approved IN ('1','0')" );
} );

// ── Manifest load ─────────────────────────────────────────────────────
$manifest_rel = isset( $args[0] ) ? $args[0] : 'wp-content/to-wordpress/import-manifest.json';
$manifest_path = ABSPATH . ltrim( $manifest_rel, '/' );
if ( ! file_exists( $manifest_path ) ) {
    WP_CLI::error( 'manifest not found: ' . $manifest_path );
}
$manifest_raw = file_get_contents( $manifest_path );
$manifest = json_decode( $manifest_raw, true );
if ( ! is_array( $manifest ) ) {
    WP_CLI::error( 'invalid manifest JSON at ' . $manifest_path . ' (json_last_error=' . json_last_error_msg() . ')' );
}
if ( empty( $manifest['items'] ) || ! is_array( $manifest['items'] ) ) {
    WP_CLI::warning( 'manifest has no items to import' );
}

towp_try( 'site_title', function () use ( $manifest ) {
    if ( ! empty( $manifest['site_title'] ) ) {
        update_option( 'blogname', $manifest['site_title'] );
    }
} );
towp_try( 'permalink_structure', function () use ( $manifest ) {
    if ( ! empty( $manifest['permalink_structure'] ) ) {
        update_option( 'permalink_structure', $manifest['permalink_structure'] );
    }
} );

require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';
require_once ABSPATH . 'wp-admin/includes/image.php';

// ── Media sideload ────────────────────────────────────────────────────
$media_map = [];
$work_mount = isset( $manifest['work_mount'] ) ? trim( (string) $manifest['work_mount'], '/' ) : '';
$media_rel = isset( $manifest['media_dir_relative'] ) ? trim( (string) $manifest['media_dir_relative'], '/' ) : '';
$work_root = ABSPATH . $work_mount;
$media_dir = $work_root . '/' . $media_rel;

$media_count = 0;
$media_skipped = 0;
foreach ( (array) ( $manifest['media'] ?? [] ) as $m ) {
    if ( empty( $m['basename'] ) ) { $media_skipped++; continue; }
    $basename = (string) $m['basename'];
    towp_try( 'media:' . $basename, function () use ( $m, $media_dir, &$media_map, &$media_count, $basename ) {
        $source_file = $media_dir . '/' . $basename;
        if ( ! file_exists( $source_file ) ) {
            WP_CLI::warning( 'missing media: ' . $source_file );
            return;
        }
        $existing = get_posts( [
            'post_type'      => 'attachment',
            'meta_key'       => '_towp_media_basename',
            'meta_value'     => $basename,
            'posts_per_page' => 1,
            'fields'         => 'ids',
        ] );
        if ( ! empty( $existing ) ) {
            $media_map[ $basename ] = (int) $existing[0];
            return;
        }
        $tmp = wp_tempnam( $basename );
        if ( ! $tmp || ! @copy( $source_file, $tmp ) ) {
            @unlink( $tmp );
            WP_CLI::warning( 'failed to stage media: ' . $basename );
            return;
        }
        $attachment_id = media_handle_sideload( [ 'name' => $basename, 'tmp_name' => $tmp ], 0 );
        if ( is_wp_error( $attachment_id ) ) {
            @unlink( $tmp );
            WP_CLI::warning( 'failed media: ' . $basename . ': ' . $attachment_id->get_error_message() );
            return;
        }
        update_post_meta( $attachment_id, '_towp_media_basename', $basename );
        $media_map[ $basename ] = (int) $attachment_id;
        $media_count++;
    } );
}
WP_CLI::log( 'media: ' . $media_count . ' imported, ' . $media_skipped . ' skipped, ' . count( $media_map ) . ' total mapped' );

$user_map = [];
function towp_ensure_user( $login, $email ) {
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

function towp_ensure_terms( $names, $taxonomy ) {
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

function towp_rewrite_media_refs( $content, $media_map ) {
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

// ── Items loop ────────────────────────────────────────────────────────
$created = 0;
$updated = 0;
$skipped = 0;
$registered_types = get_post_types( [], 'names' );
foreach ( (array) ( $manifest['items'] ?? [] ) as $item_idx => $item ) {
    if ( ! is_array( $item ) ) { $skipped++; continue; }
    $slug_raw = isset( $item['slug'] ) ? (string) $item['slug'] : '';
    $slug = sanitize_title( $slug_raw );
    if ( ! $slug ) {
        $slug = 'imported-' . $item_idx;
    }
    $post_type = isset( $item['post_type'] ) && $item['post_type'] ? (string) $item['post_type'] : 'post';
    // If the manifest references a CPT that was never registered (e.g.
    // the plugin failed to activate), fall back to 'post' instead of
    // letting wp_insert_post reject the whole row.
    if ( ! in_array( $post_type, $registered_types, true ) ) {
        WP_CLI::warning( 'unknown post_type "' . $post_type . '" for "' . $slug . '" — falling back to "post"' );
        $post_type = 'post';
    }

    $GLOBALS['towp_current_item'] = [ 'slug' => $slug, 'post_type' => $post_type ];

    $result = towp_try( 'item:' . $post_type . ':' . $slug, function () use ( $item, $slug, $post_type, $media_map, &$created, &$updated ) {
        $existing = get_page_by_path( $slug, OBJECT, $post_type );
        $content = towp_rewrite_media_refs( isset( $item['content'] ) ? (string) $item['content'] : '', $media_map );
        $author_id = isset( $item['author_login'] ) && $item['author_login']
            ? towp_ensure_user( (string) $item['author_login'], isset( $item['author_email'] ) ? (string) $item['author_email'] : '' )
            : 0;
        $date_str = isset( $item['date'] ) ? (string) $item['date'] : '';
        $ts = $date_str ? strtotime( $date_str ) : false;
        if ( ! $ts ) { $ts = time(); }
        $status = isset( $item['status'] ) && $item['status'] ? (string) $item['status'] : 'publish';
        // WordPress only accepts a known-good status string.
        $allowed_statuses = [ 'publish', 'draft', 'pending', 'private', 'future', 'trash' ];
        if ( ! in_array( $status, $allowed_statuses, true ) ) { $status = 'draft'; }

        $data = [
            'post_type'    => $post_type,
            'post_title'   => isset( $item['title'] ) ? (string) $item['title'] : $slug,
            'post_name'    => $slug,
            'post_status'  => $status,
            'post_date'    => gmdate( 'Y-m-d H:i:s', $ts ),
            'post_date_gmt'=> gmdate( 'Y-m-d H:i:s', $ts ),
            'post_content' => $content,
            'post_excerpt' => isset( $item['excerpt'] ) ? (string) $item['excerpt'] : '',
            'post_author'  => $author_id ?: 1,
        ];
        if ( $existing ) {
            $data['ID'] = $existing->ID;
            $post_id = wp_update_post( wp_slash( $data ), true );
            if ( is_wp_error( $post_id ) ) { throw new \\RuntimeException( $post_id->get_error_message() ); }
            $updated++;
        } else {
            $post_id = wp_insert_post( wp_slash( $data ), true );
            if ( is_wp_error( $post_id ) ) { throw new \\RuntimeException( $post_id->get_error_message() ); }
            $created++;
        }
        // Terms: only set when the taxonomy is actually registered for
        // this post type — otherwise wp_set_object_terms will warn.
        if ( ! empty( $item['categories'] ) && taxonomy_exists( 'category' ) ) {
            $cat_ids = towp_ensure_terms( (array) $item['categories'], 'category' );
            if ( $cat_ids ) { wp_set_object_terms( $post_id, $cat_ids, 'category', false ); }
        }
        if ( ! empty( $item['tags'] ) && taxonomy_exists( 'post_tag' ) ) {
            wp_set_object_terms( $post_id, (array) $item['tags'], 'post_tag', false );
        }
        if ( ! empty( $item['meta'] ) && is_array( $item['meta'] ) ) {
            foreach ( $item['meta'] as $k => $v ) {
                // WP meta keys must be scalar strings; skip anything weird.
                if ( ! is_string( $k ) || $k === '' ) continue;
                update_post_meta( $post_id, $k, $v );
            }
        }
        if ( ! empty( $item['featured_image_rel'] ) ) {
            $rel = (string) $item['featured_image_rel'];
            $base = basename( $rel );
            $flat = str_replace( '/', '__', ltrim( $rel, '/' ) );
            if ( isset( $media_map[ $flat ] ) ) {
                set_post_thumbnail( $post_id, $media_map[ $flat ] );
            } elseif ( isset( $media_map[ $base ] ) ) {
                set_post_thumbnail( $post_id, $media_map[ $base ] );
            }
        }
        return $post_id;
    } );
    if ( $result === null ) { $skipped++; }
    $GLOBALS['towp_current_item'] = null;
}
WP_CLI::log( 'items: ' . $created . ' created, ' . $updated . ' updated, ' . $skipped . ' skipped' );

// ── Front page / blog / privacy settings ──────────────────────────────
towp_try( 'front_page', function () use ( $manifest ) {
    if ( empty( $manifest['front_page_slug'] ) ) { return; }
    $home = get_page_by_path( sanitize_title( $manifest['front_page_slug'] ), OBJECT, 'page' );
    if ( $home ) {
        update_option( 'show_on_front', 'page' );
        update_option( 'page_on_front', (int) $home->ID );
        WP_CLI::log( 'front page: ' . $home->post_title . ' (#' . $home->ID . ')' );
    }
} );

towp_try( 'blog_index', function () use ( $manifest ) {
    if ( ! empty( $manifest['blog_index_page_slug'] ) ) {
        $blog = get_page_by_path( sanitize_title( $manifest['blog_index_page_slug'] ), OBJECT, 'page' );
        if ( $blog ) {
            update_option( 'page_for_posts', (int) $blog->ID );
            WP_CLI::log( 'blog index: ' . $blog->post_title . ' (#' . $blog->ID . ')' );
        }
    } elseif ( empty( $manifest['front_page_slug'] ) ) {
        update_option( 'page_for_posts', 0 );
    }
} );

towp_try( 'privacy_page', function () use ( $manifest ) {
    if ( empty( $manifest['privacy_page_slug'] ) ) { return; }
    $priv = get_page_by_path( sanitize_title( $manifest['privacy_page_slug'] ), OBJECT, 'page' );
    if ( $priv ) {
        update_option( 'wp_page_for_privacy_policy', (int) $priv->ID );
        WP_CLI::log( 'privacy page: ' . $priv->post_title . ' (#' . $priv->ID . ')' );
    }
} );

// ── Page templates ────────────────────────────────────────────────────
towp_try( 'page_templates', function () use ( $manifest ) {
    $theme_dir = get_stylesheet_directory();
    foreach ( (array) ( $manifest['items'] ?? [] ) as $it ) {
        if ( empty( $it['layout'] ) || ( $it['post_type'] ?? '' ) !== 'page' ) { continue; }
        $slug = sanitize_title( $it['slug'] ?? '' );
        if ( ! $slug ) { continue; }
        $page = get_page_by_path( $slug, OBJECT, 'page' );
        if ( ! $page ) { continue; }
        $layout = sanitize_title( $it['layout'] );
        $candidates = [ 'page-' . $layout . '.php', 'page-templates/' . $layout . '.php', 'template-' . $layout . '.php' ];
        $chosen = 'default';
        foreach ( $candidates as $c ) {
            if ( file_exists( $theme_dir . '/' . $c ) ) { $chosen = $c; break; }
        }
        if ( $chosen !== 'default' ) {
            update_post_meta( $page->ID, '_wp_page_template', $chosen );
        }
    }
} );

// ── Primary nav menu ──────────────────────────────────────────────────
towp_try( 'primary_menu', function () use ( $manifest ) {
    if ( empty( $manifest['menu_items'] ) || ! is_array( $manifest['menu_items'] ) ) { return; }
    $menu_name = 'Primary';
    $menu = wp_get_nav_menu_object( $menu_name );
    if ( ! $menu ) {
        $menu_id = wp_create_nav_menu( $menu_name );
    } else {
        $menu_id = (int) $menu->term_id;
        $existing = wp_get_nav_menu_items( $menu_id );
        if ( is_array( $existing ) ) {
            foreach ( $existing as $mi ) { wp_delete_post( $mi->ID, true ); }
        }
    }
    if ( is_wp_error( $menu_id ) ) { return; }

    $add = function ( $items, $parent_id ) use ( $menu_id, &$add ) {
        foreach ( (array) $items as $item ) {
            if ( ! is_array( $item ) ) { continue; }
            $title = isset( $item['title'] ) ? (string) $item['title'] : '';
            $url = isset( $item['url'] ) ? (string) $item['url'] : '';
            if ( ! $title || ! $url ) { continue; }
            // Resolve URL smartly: external/absolute links pass through
            // verbatim, site-relative paths get home_url() applied. Use
            // ~ delimiters so '#' inside the pattern doesn't collide.
            if ( preg_match( '~^(https?:|mailto:|tel:|sms:|ftp:|#|//)~i', $url ) ) {
                $resolved_url = $url;
            } else {
                $resolved_url = home_url( '/' . ltrim( $url, '/' ) );
            }
            $new_id = wp_update_nav_menu_item( $menu_id, 0, [
                'menu-item-title'     => $title,
                'menu-item-url'       => $resolved_url,
                'menu-item-status'    => 'publish',
                'menu-item-parent-id' => (int) $parent_id,
            ] );
            if ( ! is_wp_error( $new_id ) && ! empty( $item['children'] ) && is_array( $item['children'] ) ) {
                $add( $item['children'], (int) $new_id );
            }
        }
    };
    $add( $manifest['menu_items'], 0 );

    $locations = get_theme_mod( 'nav_menu_locations' );
    if ( ! is_array( $locations ) ) { $locations = []; }
    $locations['primary'] = (int) $menu_id;
    set_theme_mod( 'nav_menu_locations', $locations );
    WP_CLI::log( 'primary menu populated with ' . count( $manifest['menu_items'] ) . ' top-level items' );
} );

towp_try( 'flush_rewrite_rules', function () { flush_rewrite_rules( false ); } );

if ( ! empty( $towp_failures ) ) {
    WP_CLI::warning( sprintf( 'import completed with %d non-fatal failures', count( $towp_failures ) ) );
    foreach ( array_slice( $towp_failures, 0, 20 ) as $f ) {
        WP_CLI::log( '  - ' . $f );
    }
    if ( count( $towp_failures ) > 20 ) {
        WP_CLI::log( '  … ' . ( count( $towp_failures ) - 20 ) . ' more' );
    }
}

WP_CLI::success( sprintf(
    'import: %d created, %d updated, %d skipped, %d media',
    $created, $updated, $skipped, count( $media_map )
) );
`;
}
