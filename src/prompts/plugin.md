{{SHARED}}

## Phase: Pluginize

Produce a single site-specific WordPress plugin targeting **WordPress
6.9+** (PHP 7.2.24+) that owns everything "non-theme" about the source
site: custom post types, taxonomies, **shortcodes**, comments
integration, newsletter, analytics, cookie banner, redirects map, **AND
every custom behavior from the source SSG's plugins** (generators,
custom endpoints, alternate views). These concerns must survive a theme
change — they do NOT belong in the theme.

Follow the official Plugin Handbook: https://developer.wordpress.org/plugins/

---

## Non-negotiable: plugin structure

Per https://developer.wordpress.org/plugins/plugin-basics/ — the main
file MUST be a minimal bootstrap. ALL business logic lives in
`includes/*.php` files loaded from the bootstrap.

```
{{PLUGIN_DIR}}/
├── {{PLUGIN_SLUG}}.php      # Plugin header + require_once loop (ONLY)
├── readme.txt               # Standard WP plugin readme
├── uninstall.php            # Data cleanup on delete
├── includes/
│   ├── cpt.php              # register_post_type
│   ├── taxonomies.php       # register_taxonomy
│   ├── endpoints.php        # SSG plugin URL endpoints (e.g. /llm/)
│   ├── generators.php       # Content transforms / alternate views
│   ├── rest-api.php         # Custom REST routes
│   ├── shortcodes.php       # add_shortcode
│   ├── redirects.php        # template_redirect 301 map
│   ├── options.php          # Settings API
│   ├── newsletter.php       # If features.newsletterFormAction
│   ├── comments-giscus.php  # If features.giscusRepo
│   ├── analytics-ga.php     # If features.googleAnalyticsId
│   ├── cookie-banner.php    # If features.cookieBanner
│   ├── dark-mode.php        # If features.darkMode
│   └── social-meta.php      # If features.twitterSite
└── languages/               # Translations (if any)
```

### Bootstrap rules

`{{PLUGIN_SLUG}}.php`:

```php
<?php
/**
 * Plugin Name: {{SITE_TITLE}} Site
 * Plugin URI:
 * Description: Site-specific plugin for {{SITE_TITLE}} — CPTs, shortcodes, analytics, redirects, endpoints, and other non-theme features migrated by to-wordpress.
 * Version: 0.1.0
 * Requires at least: 6.3
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 * Text Domain: {{PLUGIN_SLUG}}
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }

// Load every include file in deterministic order.
foreach ( glob( plugin_dir_path( __FILE__ ) . 'includes/*.php' ) as $__inc ) {
    require_once $__inc;
}
```

**Forbidden in the bootstrap**: business logic, class definitions, hook
callbacks, anything other than the header, `ABSPATH` guard, and the
include loop. All code lives in `includes/*.php`.

---

## SSG Plugin Migration (CRITICAL)

The source site ships SSG-level plugins that produce custom URLs and
content transforms. **You MUST analyze each one and replicate its
behavior in WordPress.** This is the single biggest gap in a typical
Jekyll → WordPress migration.

Source SSG plugin files:

{{SSG_PLUGINS_SOURCE}}

### Analysis procedure (for every file above)

1. **Read the full source code.** Understand what it generates.
2. **Identify the pattern**:

| SSG pattern | WordPress equivalent |
|---|---|
| Generator that creates a parallel URL tree (e.g. `/llm/{slug}/` mirroring `/blog/{slug}/`) | `add_rewrite_rule` + `query_vars` filter + `template_include` filter |
| Generator that creates category/tag index pages | Native taxonomy archives (plus rewrite rule if source uses custom URL pattern) |
| Generator that creates data-driven pages from YAML/JSON | Custom REST route + page template, or a page with a dynamic block |
| `content` transformation (syntax highlighting, markdown post-processing) | `the_content` filter |
| Custom feed | `add_feed( 'slug', callback )` + callback outputs XML |
| Custom front matter behavior | `register_meta` with `show_in_rest` + filter hooks |

3. **Generate the WordPress file** in the correct `includes/<name>.php`.
4. **Flush rewrite rules on activation** if you added rewrite rules.

### Example: `/llm/` endpoint (raw-markdown view of posts)

Jekyll plugins like `llm_generator.rb` build a synthetic `llm_posts`
collection — one page per post at `/llm/{slug}/` that displays the raw
markdown inside `<pre>` with `<context>` and `<instructions>` blocks for
LLM consumption.

The WordPress equivalent in `includes/endpoints.php`:

```php
<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * LLM view endpoint: /llm/{post-slug}/ renders a post's raw content
 * in a format optimized for language model consumption.
 */

add_action( 'init', function () {
    add_rewrite_rule(
        '^llm/([^/]+)/?$',
        'index.php?{{PLUGIN_SLUG_UNDERSCORED}}_llm_slug=$matches[1]',
        'top'
    );
} );

add_filter( 'query_vars', function ( $vars ) {
    $vars[] = '{{PLUGIN_SLUG_UNDERSCORED}}_llm_slug';
    return $vars;
} );

add_filter( 'template_include', function ( $template ) {
    $slug = get_query_var( '{{PLUGIN_SLUG_UNDERSCORED}}_llm_slug' );
    if ( ! $slug ) {
        return $template;
    }
    $post = get_page_by_path( $slug, OBJECT, [ 'post', 'page' ] );
    if ( ! $post ) {
        status_header( 404 );
        return get_404_template();
    }
    $plugin_template = plugin_dir_path( __FILE__ ) . '../templates/llm-view.php';
    if ( file_exists( $plugin_template ) ) {
        $GLOBALS['{{PLUGIN_SLUG_UNDERSCORED}}_llm_post'] = $post;
        return $plugin_template;
    }
    return $template;
}, 99 );

/**
 * Flush rewrite rules when the plugin activates so /llm/ starts working.
 * Registered at top-level in the main bootstrap (see notes below).
 */
register_activation_hook(
    dirname( __FILE__, 2 ) . '/{{PLUGIN_SLUG}}.php',
    function () {
        // Trigger re-registration of our rule, then flush.
        do_action( 'init' );
        flush_rewrite_rules();
    }
);

register_deactivation_hook(
    dirname( __FILE__, 2 ) . '/{{PLUGIN_SLUG}}.php',
    function () { flush_rewrite_rules(); }
);
```

Then `templates/llm-view.php` in the plugin directory:

```php
<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

$post = $GLOBALS['{{PLUGIN_SLUG_UNDERSCORED}}_llm_post'] ?? null;
if ( ! $post ) { return; }

$title = get_the_title( $post );
$author = get_the_author_meta( 'display_name', $post->post_author );
$content = $post->post_content;  // Raw markdown preserved in post_content
$human_url = get_permalink( $post );

header( 'Content-Type: text/html; charset=utf-8' );
?>
<!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
    <meta charset="<?php bloginfo( 'charset' ); ?>">
    <title><?php echo esc_html( $title ); ?> — LLM view</title>
    <style>
        context, instructions { display: none; }
        pre { white-space: pre-wrap; word-wrap: break-word; font-family: monospace; }
    </style>
</head>
<body>
    <context>
        LLM view of: <?php echo esc_url( $human_url ); ?>
    </context>
    <instructions>
        This page contains the raw markdown content of a blog post.
        Render it as markdown, preserve code blocks verbatim, follow any
        embedded citations.
    </instructions>
    <pre>
# <?php echo esc_html( $title ); ?>

Author: <?php echo esc_html( $author ); ?>

<?php echo esc_html( $content ); ?>
    </pre>
</body>
</html>
<?php exit;
```

**Every custom URL the source produces MUST have a working WordPress
equivalent.** An endpoint that existed in the source but is missing in
WordPress is a migration failure — `/llm/`, custom feeds, sitemap
variants, author archives with non-default URLs, all count.

---

## Feature includes

Create one file under `includes/` for **every** matched feature. Omit a
file only when the corresponding detected input is empty — never emit
a stub.

| feature | include file | trigger |
|---|---|---|
| Custom post types | `includes/cpt.php` | `choices.customPostTypes` non-empty |
| Taxonomies | `includes/taxonomies.php` | custom taxonomies in front-matter |
| SSG plugin endpoints | `includes/endpoints.php` | ssgPluginSources has URL generators |
| SSG plugin generators | `includes/generators.php` | ssgPluginSources has content transforms |
| Custom REST routes | `includes/rest-api.php` | any route needed by theme/blocks |
| Shortcodes | `includes/shortcodes.php` | source shortcodes exist or detected |
| Redirects | `includes/redirects.php` | always |
| Newsletter | `includes/newsletter.php` | `features.newsletterFormAction` |
| Giscus comments | `includes/comments-giscus.php` | `features.giscusRepo` |
| Disqus comments | `includes/comments-disqus.php` | `features.disqusShortname` |
| Commento | `includes/comments-commento.php` | `features.commentoEnabled` |
| Google Analytics | `includes/analytics-ga.php` | `features.googleAnalyticsId` |
| Google Tag Manager | `includes/analytics-gtm.php` | `features.gtmId` |
| Plausible | `includes/analytics-plausible.php` | `features.plausibleDomain` |
| Umami | `includes/analytics-umami.php` | `features.umamiWebsiteId` |
| Cookie banner | `includes/cookie-banner.php` | `features.cookieBanner` |
| Dark mode | `includes/dark-mode.php` | `features.darkMode` |
| Social meta | `includes/social-meta.php` | `features.twitterSite` or similar |
| Options page | `includes/options.php` | always |

---

## Per-feature implementation rules

### Custom post types (`cpt.php`)

Per https://developer.wordpress.org/reference/functions/register_post_type/:

```php
<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

add_action( 'init', function () {
    register_post_type( 'my_cpt', [
        'labels'        => [
            'name'          => __( 'Items', '{{PLUGIN_SLUG}}' ),
            'singular_name' => __( 'Item', '{{PLUGIN_SLUG}}' ),
            // ... full labels array
        ],
        'public'        => true,
        'show_in_rest'  => true,   // Enable block editor + REST API
        'has_archive'   => true,
        'supports'      => [ 'title', 'editor', 'excerpt', 'thumbnail',
                              'custom-fields', 'author', 'comments',
                              'revisions' ],
        'rewrite'       => [ 'slug' => '<pathPrefix>', 'with_front' => false ],
        'menu_icon'     => 'dashicons-...',
    ] );
} );
```

Do **not** flush rewrite rules inside this function. Let the activation
hook (in the bootstrap or in `includes/endpoints.php`) handle it.

### Taxonomies (`taxonomies.php`)

```php
<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

add_action( 'init', function () {
    register_taxonomy( 'my_category', [ 'my_cpt' ], [
        'hierarchical'     => true,
        'show_in_rest'     => true,
        'labels'           => [ /* ... */ ],
        'rewrite'          => [ 'slug' => 'my-category' ],
    ] );
} );
```

### Shortcodes (`shortcodes.php`)

Reusable source fragments must be migrated as **shortcodes**, not
Gutenberg blocks or dynamic blocks. The normalize phase rewrites Liquid includes into
`[towp_<name> ...]` shortcodes, and the classic theme styles the output
with CSS. This plugin must register a real handler for every discovered
name below:

```json
{{SHORTCODES_JSON}}
```

{{SHORTCODES_LIST}}

For each shortcode:

1. Find the source include template at `_includes/**/<name>.html` (try
   `framework/shortcodes/<name>.html`, `shortcodes/<name>.html`, and
   generic `_includes/**/<name>.html`).
2. Port its Liquid markup to PHP. Preserve the DOM, classes, attribute
   names, wrappers, and fallback behavior.
3. Register the handler on `init` using `add_shortcode( 'towp_<name>', ... )`.
4. Escape every attribute/output value.

Example shape:

```php
<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

add_action( 'init', function () {
    add_shortcode( 'towp_figure', function ( $atts, $content = null ) {
        $atts = shortcode_atts( [
            'src'     => '',
            'alt'     => '',
            'caption' => '',
            'class'   => '',
        ], (array) $atts, 'towp_figure' );

        if ( ! $atts['src'] ) { return ''; }

        $classes = trim( 'towp-shortcode towp-shortcode-figure ' . $atts['class'] );
        $caption = $atts['caption']
            ? '<figcaption class="wp-element-caption">' . esc_html( $atts['caption'] ) . '</figcaption>'
            : '';

        return sprintf(
            '<figure class="%s"><img src="%s" alt="%s" />%s</figure>',
            esc_attr( $classes ),
            esc_url( $atts['src'] ),
            esc_attr( $atts['alt'] ),
            $caption
        );
    } );
} );
```

If no exact source include exists, generate a useful semantic fallback
for the shortcode type. Do not render literal bracket text. Do not output
`TODO`.

### REST routes (`rest-api.php`)

Per https://developer.wordpress.org/rest-api/extending-the-rest-api/adding-custom-endpoints/:

```php
<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

add_action( 'rest_api_init', function () {
    register_rest_route( '{{PLUGIN_SLUG}}/v1', '/data/(?P<key>[a-z0-9_-]+)', [
        'methods'             => WP_REST_Server::READABLE,
        'permission_callback' => '__return_true',
        'args'                => [
            'key' => [
                'required'          => true,
                'validate_callback' => function ( $v ) { return is_string( $v ) && preg_match( '/^[a-z0-9_-]+$/', $v ); },
                'sanitize_callback' => 'sanitize_key',
            ],
        ],
        'callback'            => function ( WP_REST_Request $req ) {
            $key = $req->get_param( 'key' );
            $data = get_option( '{{PLUGIN_SLUG_UNDERSCORED}}_data_' . $key );
            if ( ! $data ) {
                return new WP_Error( 'not_found', 'Not found', [ 'status' => 404 ] );
            }
            return rest_ensure_response( $data );
        },
    ] );
} );
```

**Rules**:

- Always provide `permission_callback` (use `__return_true` for public).
- Always validate + sanitize `args`.
- Return `WP_Error` with `status` for errors, `rest_ensure_response()`
  for success.
- Use unique namespace `{{PLUGIN_SLUG}}/v1` — never `wp/*`.

### Redirects (`redirects.php`)

```php
<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

add_action( 'template_redirect', function () {
    if ( is_user_logged_in() && current_user_can( 'manage_options' ) ) {
        return;
    }
    $file = dirname( __FILE__, 2 ) . '/../redirects.json';
    if ( ! file_exists( $file ) ) { return; }
    $map = json_decode( file_get_contents( $file ), true );
    if ( ! is_array( $map ) ) { return; }
    $path = rtrim( wp_parse_url( add_query_arg( [] ), PHP_URL_PATH ), '/' ) . '/';
    if ( isset( $map[ $path ] ) ) {
        wp_safe_redirect( home_url( $map[ $path ] ), 301 );
        exit;
    }
} );
```

### Options page / Settings API (`options.php`)

Per https://developer.wordpress.org/plugins/settings/settings-api/:

```php
<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

add_action( 'admin_menu', function () {
    add_options_page(
        __( '{{SITE_TITLE}} Settings', '{{PLUGIN_SLUG}}' ),
        __( '{{SITE_TITLE}}', '{{PLUGIN_SLUG}}' ),
        'manage_options',
        '{{PLUGIN_SLUG_UNDERSCORED}}_settings',
        '{{PLUGIN_SLUG_UNDERSCORED}}_render_settings_page'
    );
} );

add_action( 'admin_init', function () {
    register_setting(
        '{{PLUGIN_SLUG_UNDERSCORED}}_settings_group',
        '{{PLUGIN_SLUG_UNDERSCORED}}_options',
        [ 'sanitize_callback' => '{{PLUGIN_SLUG_UNDERSCORED}}_sanitize_options' ]
    );
    add_settings_section( '{{PLUGIN_SLUG_UNDERSCORED}}_main', __( 'Main', '{{PLUGIN_SLUG}}' ), '__return_false', '{{PLUGIN_SLUG_UNDERSCORED}}_settings' );
    add_settings_field(
        'ga_id',
        __( 'Google Analytics ID', '{{PLUGIN_SLUG}}' ),
        '{{PLUGIN_SLUG_UNDERSCORED}}_field_ga_id',
        '{{PLUGIN_SLUG_UNDERSCORED}}_settings',
        '{{PLUGIN_SLUG_UNDERSCORED}}_main'
    );
} );

function {{PLUGIN_SLUG_UNDERSCORED}}_sanitize_options( $input ) {
    $out = [];
    $out['ga_id'] = isset( $input['ga_id'] ) ? sanitize_text_field( wp_unslash( $input['ga_id'] ) ) : '';
    return $out;
}

function {{PLUGIN_SLUG_UNDERSCORED}}_field_ga_id() {
    $opts = get_option( '{{PLUGIN_SLUG_UNDERSCORED}}_options', [] );
    printf(
        '<input type="text" name="%s[ga_id]" value="%s" class="regular-text" />',
        esc_attr( '{{PLUGIN_SLUG_UNDERSCORED}}_options' ),
        esc_attr( $opts['ga_id'] ?? '' )
    );
}

function {{PLUGIN_SLUG_UNDERSCORED}}_render_settings_page() {
    if ( ! current_user_can( 'manage_options' ) ) { return; }
    ?>
    <div class="wrap">
        <h1><?php esc_html_e( '{{SITE_TITLE}} Settings', '{{PLUGIN_SLUG}}' ); ?></h1>
        <form method="post" action="options.php">
            <?php
            settings_fields( '{{PLUGIN_SLUG_UNDERSCORED}}_settings_group' );
            do_settings_sections( '{{PLUGIN_SLUG_UNDERSCORED}}_settings' );
            submit_button();
            ?>
        </form>
    </div>
    <?php
}
```

**Rules** (from
https://developer.wordpress.org/plugins/security/):

- `register_setting()` with a `sanitize_callback`.
- Every field display function uses `esc_attr()` / `esc_html()`.
- Settings page render function checks `current_user_can()`.
- The Settings API handles nonces automatically via `settings_fields()`.

### Security baseline (every feature)

Per https://developer.wordpress.org/apis/security/nonces/:

- **Nonces prevent CSRF, not authorization.** Always pair with
  `current_user_can()`.
- Never process `$_POST` / `$_GET` wholesale. Read explicit keys.
- Use `wp_unslash()` before sanitizing.
- SQL: use `$wpdb->prepare()`. Never concatenate user input.
- Escape on output: `esc_html`, `esc_attr`, `esc_url`, `wp_kses_post`.

### Activation / deactivation / uninstall

Per https://developer.wordpress.org/plugins/plugin-basics/activation-deactivation-hooks/:

- Register hooks at **top-level** — not inside other hooks.
- Flush rewrite rules only if your plugin registers rewrite rules.
- Uninstall uses `uninstall.php` (runs only on plugin delete).

`uninstall.php`:

```php
<?php
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) { exit; }

// Remove plugin options.
delete_option( '{{PLUGIN_SLUG_UNDERSCORED}}_options' );
delete_option( '{{PLUGIN_SLUG_UNDERSCORED}}_version' );

// Do NOT delete posts, pages, or media — those belong to the site.
```

## Scope

- Write allowed: only inside `{{PLUGIN_DIR}}`.
- Read allowed: anything under `{{SOURCE_DIR}}` and `{{PLUGIN_DIR}}`.
- Do NOT touch the theme directory, content directory, or database.

## Plugin metadata

- Plugin slug: `{{PLUGIN_SLUG}}`
- Underscored prefix: `{{PLUGIN_SLUG_UNDERSCORED}}`
- Text domain: `{{PLUGIN_SLUG}}`

## Source kind

**`{{SOURCE_KIND}}`**. Detector briefing:

> {{DETECTOR_BRIEFING}}

## Inputs

Detected context:

```json
{{DETECTED_JSON}}
```

User choices:

```json
{{CHOICES_JSON}}
```

---

## Code-quality rules

1. **Prefix everything**. Neutral helpers use `towp_`; plugin-specific
   functions, hooks, options, post meta keys, block names use
   `{{PLUGIN_SLUG_UNDERSCORED}}_`.
2. **Every file** starts with `<?php` then `if ( ! defined( 'ABSPATH' ) ) { exit; }`.
3. **Escape on output, sanitize on input.** Never the reverse.
4. **Nonces** on every form and AJAX action; paired with capability checks.
5. **Translation-ready**. Every user-visible string uses text domain `{{PLUGIN_SLUG}}`.
6. **No build step** (no composer, no npm) unless a block requires it.
7. **No external HTTP** from PHP except to analytics/newsletter endpoints already
   in detected context.
8. **Admin-only code** behind admin hooks / `is_admin()` to reduce frontend load.

## Anti-patterns (banned)

- Unprefixed function/hook/option names.
- Storing config as PHP constants instead of options.
- Hard-coded IDs, domains, tracking keys.
- Stub files that only `echo 'TODO';`.
- Logic in the main plugin file (beyond header + include loop).
- `@include` instead of `require_once`.
- Raw `$_POST` / `$_GET` handling without sanitize + validate.

---

## Self-check (walk every item before stopping)

- [ ] `{{PLUGIN_SLUG}}.php` has only the plugin header + ABSPATH guard +
      `require_once` loop. No business logic.
- [ ] Every SSG plugin in `{{SSG_PLUGINS_SOURCE}}` has a matching
      WordPress implementation under `includes/`.
- [ ] If source has `/llm/` generator: `includes/endpoints.php` registers
      rewrite + query var + template_include + activation hook flushing
      rewrite rules. A `plugins/<slug>/templates/llm-view.php` exists and
      renders markdown in `<pre>`.
- [ ] Every entry in `{{SHORTCODES_JSON}}` has an `add_shortcode` handler
      with fully escaped attribute output.
- [ ] Every CPT in `choices.customPostTypes` has `show_in_rest: true` and
      proper `labels` array.
- [ ] Options page reachable at `Settings → {{SITE_TITLE}}`.
- [ ] `uninstall.php` checks `WP_UNINSTALL_PLUGIN` and only removes
      plugin-created options (not posts/pages/media).
- [ ] Every `$_POST` / `$_GET` access uses `wp_unslash()` + a sanitize fn.
- [ ] No unprefixed function/hook/option/meta key names.
- [ ] No placeholder strings, no TODOs, no hard-coded domains.
