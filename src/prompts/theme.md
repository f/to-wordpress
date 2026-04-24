{{SHARED}}

## Phase: Block Theme (FSE)

Produce a **block theme** targeting **WordPress 6.9+** (PHP 7.2.24+) that
reproduces the source site with high fidelity. This is not a classic
theme — the Site Editor, `theme.json`, HTML templates, and filesystem
patterns are your only building blocks.

Follow the official WordPress Block Theme conventions: https://developer.wordpress.org/themes/block-themes/theme-structure/

---

## Non-negotiable: file structure

A block theme is defined by its file layout. ALL of these rules are
mandatory — violating any of them produces a broken theme that
WordPress rejects silently.

```
{{THEME_DIR}}/
├── style.css                # Theme header + compiled CSS
├── theme.json               # Global settings + styles (version 3)
├── functions.php            # Hooks, enqueues, menu registration
├── templates/               # HTML block templates (NOT PHP)
│   ├── index.html           # Required fallback
│   ├── front-page.html      # Optional — home at `/`
│   ├── home.html            # Optional — blog posts index
│   ├── single.html          # Single post
│   ├── page.html            # Single page
│   ├── archive.html         # Category/tag/date archives
│   ├── search.html          # Search results
│   ├── 404.html             # Not found
│   └── page-<slug>.html     # Custom page templates
├── parts/                   # Reusable template parts (HTML, flat — NOT nested)
│   ├── header.html
│   ├── footer.html
│   └── sidebar.html         # If source has sidebar
├── patterns/                # Filesystem block patterns (PHP with header)
│   └── hero.php
├── styles/                  # Optional style variations (JSON)
│   └── dark.json
├── inc/
│   ├── data.php             # PHP transcription of _data_source/*.yml
│   ├── enqueue.php          # Asset loading
│   └── blocks.php           # Dynamic block registrations (if any)
├── assets/                  # Static assets mirrored from source
└── screenshot.png           # 1200×900 theme preview
```

**ABSOLUTELY FORBIDDEN** — these files MUST NOT exist:

- `index.php` (in root, as a template)
- `header.php`, `footer.php`, `sidebar.php`, `single.php`, `page.php`,
  `archive.php`, `search.php`, `404.php`, `front-page.php`, `home.php`
- Any `.php` file in `templates/` or `parts/`
- Nested subdirectories inside `parts/` (template parts MUST be flat)

Only `functions.php`, `style.css`, and files in `inc/`, `patterns/`,
`styles/`, `assets/` can be PHP. Templates and parts are HTML.

---

## `theme.json` — version 3 (WordPress 6.9+)

This is the single source of truth for styles, presets, and theme
metadata. The official schema: https://schemas.wp.org/trunk/theme.json

Required structure:

```json
{
  "$schema": "https://schemas.wp.org/trunk/theme.json",
  "version": 3,
  "settings": {
    "appearanceTools": true,
    "layout": {
      "contentSize": "800px",
      "wideSize": "1200px"
    },
    "color": {
      "palette": [
        { "slug": "primary", "color": "#...", "name": "Primary" }
      ],
      "gradients": [],
      "duotone": []
    },
    "typography": {
      "fluid": true,
      "fontFamilies": [
        {
          "fontFamily": "'Inter', sans-serif",
          "slug": "inter",
          "name": "Inter",
          "fontFace": [
            { "fontFamily": "Inter", "fontWeight": "400", "fontStyle": "normal", "src": ["file:./assets/fonts/inter-400.woff2"] }
          ]
        }
      ],
      "fontSizes": [
        { "slug": "small", "size": "0.875rem", "name": "Small" },
        { "slug": "medium", "size": "1rem", "name": "Medium" },
        { "slug": "large", "size": "1.25rem", "name": "Large" },
        { "slug": "x-large", "size": "2rem", "name": "XL" }
      ]
    },
    "spacing": {
      "spacingSizes": [
        { "slug": "10", "size": "0.5rem", "name": "XS" },
        { "slug": "20", "size": "1rem", "name": "S" },
        { "slug": "30", "size": "1.5rem", "name": "M" },
        { "slug": "40", "size": "2rem", "name": "L" },
        { "slug": "50", "size": "3rem", "name": "XL" }
      ]
    },
    "border": {
      "radiusSizes": [
        { "slug": "small", "size": "4px", "name": "Small" },
        { "slug": "medium", "size": "8px", "name": "Medium" },
        { "slug": "large", "size": "16px", "name": "Large" }
      ]
    }
  },
  "styles": {
    "color": { "background": "var(--wp--preset--color--background)", "text": "var(--wp--preset--color--foreground)" },
    "typography": {
      "fontFamily": "var(--wp--preset--font-family--inter)",
      "lineHeight": "1.6"
    },
    "elements": {
      "h1": { "typography": { "fontSize": "var(--wp--preset--font-size--x-large)", "fontWeight": "700" } },
      "h2": { "typography": { "fontSize": "var(--wp--preset--font-size--large)", "fontWeight": "700" } },
      "link": { "color": { "text": "var(--wp--preset--color--primary)" } },
      "button": {
        "color": { "text": "#fff", "background": "var(--wp--preset--color--primary)" },
        "border": { "radius": "var(--wp--preset--border-radius--medium)" }
      }
    }
  },
  "templateParts": [
    { "name": "header", "title": "Header", "area": "header" },
    { "name": "footer", "title": "Footer", "area": "footer" }
  ],
  "customTemplates": [
    { "name": "page-wide", "title": "Wide Page", "postTypes": ["page"] }
  ]
}
```

**Rules**:

- Use **`version: 3`** (required for WP 6.9+).
- Populate `settings.color.palette` from `detected.colors`.
- Populate `settings.typography.fontFamilies` from `detected.fonts`.
- **`appearanceTools: true`** unlocks border, spacing, and layout UI.
- Use CSS custom properties (`var(--wp--preset--color--primary)`) in
  `styles`, not hard-coded values — that's what theme.json presets are
  for.
- Register **every** template part in `templateParts` with a valid
  `area` (`header`, `footer`, or `uncategorized`).
- Register **every** custom page template in `customTemplates` so the
  page editor exposes it in the sidebar.

---

## Templates (HTML block markup)

Every template is **HTML with WordPress block comment syntax**. Example
`templates/single.html`:

```html
<!-- wp:template-part {"slug":"header","tagName":"header"} /-->

<!-- wp:group {"tagName":"main","className":"site-main","layout":{"type":"constrained"}} -->
<main class="wp-block-group site-main">

    <!-- wp:post-featured-image {"align":"wide"} /-->

    <!-- wp:post-title {"level":1,"className":"entry-title"} /-->

    <!-- wp:group {"className":"entry-meta","layout":{"type":"flex"}} -->
    <div class="wp-block-group entry-meta">
        <!-- wp:post-date /-->
        <!-- wp:post-author-name /-->
        <!-- wp:post-terms {"term":"category"} /-->
    </div>
    <!-- /wp:group -->

    <!-- wp:post-content {"layout":{"type":"constrained"}} /-->

    <!-- wp:post-navigation-link {"type":"previous"} /-->
    <!-- wp:post-navigation-link /-->

    <!-- wp:comments-query-loop -->
    <!-- wp:comments-title /-->
    <!-- wp:comment-template -->
    <!-- wp:comment-author-name /-->
    <!-- wp:comment-date /-->
    <!-- wp:comment-content /-->
    <!-- /wp:comment-template -->
    <!-- /wp:comments-query-loop -->

</main>
<!-- /wp:group -->

<!-- wp:template-part {"slug":"footer","tagName":"footer"} /-->
```

### Block template cheat sheet

| Jekyll / Liquid | Block template |
|---|---|
| `{{ page.title }}` | `<!-- wp:post-title {"level":1} /-->` |
| `{{ content }}` | `<!-- wp:post-content /-->` |
| `{{ page.image }}` | `<!-- wp:post-featured-image /-->` |
| `{{ page.date }}` | `<!-- wp:post-date /-->` |
| `{{ page.author }}` | `<!-- wp:post-author /-->` |
| `{{ page.excerpt }}` | `<!-- wp:post-excerpt /-->` |
| `{% include header %}` | `<!-- wp:template-part {"slug":"header"} /-->` |
| Post loop | `<!-- wp:query -->...<!-- wp:post-template -->...<!-- /wp:post-template --><!-- /wp:query -->` |
| Query with filters | `<!-- wp:query {"query":{"perPage":12,"taxQuery":{"category":[1]}}} -->` |
| Pagination | `<!-- wp:query-pagination --><!-- wp:query-pagination-previous /--><!-- wp:query-pagination-next /--><!-- /wp:query-pagination -->` |
| Category list | `<!-- wp:post-terms {"term":"category"} /-->` |
| Nav menu | `<!-- wp:navigation /-->` |
| Site title | `<!-- wp:site-title /-->` |
| Site logo | `<!-- wp:site-logo /-->` |

### Required templates

- `templates/index.html` — fallback
- `templates/single.html` — single post
- `templates/page.html` — single page
- `templates/archive.html` — category/tag archives
- `templates/search.html` — search results
- `templates/404.html` — not found

### Optional but expected

- `templates/front-page.html` — static home at `/` (hero + feature cards)
- `templates/home.html` — blog posts listing (uses query loop)

### Per-layout custom templates

For every distinct source layout in the pages table, create
`templates/page-<slug>.html` and register it in `theme.json`:

```json
"customTemplates": [
  { "name": "page-wide", "title": "Wide Page", "postTypes": ["page"] }
]
```

The import phase sets `_wp_page_template` meta to match the layout
name, so custom pages render with the matching template automatically.

---

## Template parts (flat, not nested)

Parts live in `parts/*.html` — **flat directory**, no nesting. Each is
registered in `theme.json` → `templateParts`.

`parts/header.html`:

```html
<!-- wp:group {"tagName":"header","className":"site-header","layout":{"type":"flex","justifyContent":"space-between"}} -->
<header class="wp-block-group site-header">
    <!-- wp:site-title {"level":0} /-->
    <!-- wp:navigation {"ref":0,"overlayMenu":"mobile"} /-->
</header>
<!-- /wp:group -->
```

`parts/footer.html`:

```html
<!-- wp:group {"tagName":"footer","className":"site-footer","layout":{"type":"constrained"}} -->
<footer class="wp-block-group site-footer">
    <!-- wp:paragraph -->
    <p>&copy; {{SITE_TITLE}}</p>
    <!-- /wp:paragraph -->
</footer>
<!-- /wp:group -->
```

---

## Filesystem patterns (`patterns/*.php`)

Per https://developer.wordpress.org/themes/patterns/ — patterns are
registered automatically by core from the `patterns/` folder based on
file headers.

`patterns/hero.php`:

```php
<?php
/**
 * Title: Hero Section
 * Slug: {{THEME_SLUG}}/hero
 * Categories: featured, banner
 * Keywords: hero, banner
 * Viewport Width: 1400
 * Description: Large hero with headline and CTA.
 */
?>
<!-- wp:cover {"url":"<?php echo esc_url( get_template_directory_uri() . '/assets/hero.webp' ); ?>","dimRatio":30,"align":"full"} -->
<div class="wp-block-cover alignfull">
    <span class="wp-block-cover__background-dim" aria-hidden="true"></span>
    <div class="wp-block-cover__inner-container">
        <!-- wp:heading {"level":1,"textAlign":"center"} -->
        <h1 class="wp-block-heading has-text-align-center">Welcome</h1>
        <!-- /wp:heading -->
    </div>
</div>
<!-- /wp:cover -->
```

Use patterns for complex reusable sections (hero, card grid, CTA, feature
strip). Users can insert them from the pattern inserter.

---

## Dynamic blocks (when HTML isn't enough)

For source features that can't be expressed with core blocks (custom
queries, data-driven menus, shortcode fallback), register a **dynamic
block** with `register_block_type_from_metadata`:

`inc/blocks.php`:

```php
<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

add_action( 'init', function () {
    register_block_type_from_metadata(
        get_template_directory() . '/blocks/custom-menu'
    );
} );
```

`blocks/custom-menu/block.json` (**apiVersion 3 required**):

```json
{
  "$schema": "https://schemas.wp.org/trunk/block.json",
  "apiVersion": 3,
  "name": "{{THEME_SLUG}}/custom-menu",
  "title": "Custom Menu",
  "category": "theme",
  "supports": { "html": false },
  "render": "file:./render.php"
}
```

`blocks/custom-menu/render.php`:

```php
<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

$wrapper = get_block_wrapper_attributes( [ 'class' => 'custom-menu' ] );
$items = function_exists( '{{THEME_SLUG}}_data_menu' ) ? {{THEME_SLUG}}_data_menu() : [];
?>
<nav <?php echo $wrapper; ?>>
    <?php foreach ( (array) $items as $item ) : ?>
        <a href="<?php echo esc_url( $item['url'] ?? '#' ); ?>"><?php echo esc_html( $item['title'] ?? '' ); ?></a>
    <?php endforeach; ?>
</nav>
```

**Rules**:

- Always use `get_block_wrapper_attributes()` in `render.php`.
- `apiVersion: 3` is **required** for WP 6.9+ (iframe editor compatibility).
- Add `$schema` for editor tooling.

---

## `functions.php` — bootstrap only

Keep `functions.php` minimal. It handles theme support, menus, and
loads includes.

```php
<?php
/**
 * {{SITE_TITLE}} theme functions.
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

add_action( 'after_setup_theme', function () {
    add_theme_support( 'wp-block-styles' );
    add_theme_support( 'responsive-embeds' );
    add_theme_support( 'editor-styles' );
    add_theme_support( 'post-thumbnails' );
    add_theme_support( 'automatic-feed-links' );

    register_nav_menus( [
        'primary' => __( 'Primary', '{{THEME_SLUG}}' ),
        'footer'  => __( 'Footer', '{{THEME_SLUG}}' ),
    ] );
} );

require_once __DIR__ . '/inc/data.php';
require_once __DIR__ . '/inc/enqueue.php';

if ( file_exists( __DIR__ . '/inc/blocks.php' ) ) {
    require_once __DIR__ . '/inc/blocks.php';
}
```

### `inc/enqueue.php`

```php
<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

add_action( 'wp_enqueue_scripts', function () {
    $ver = wp_get_theme()->get( 'Version' );
    wp_enqueue_style( '{{THEME_SLUG}}', get_stylesheet_uri(), [], $ver );

    // Google Fonts (if detected) with display=swap.
    // wp_enqueue_style( '{{THEME_SLUG}}-fonts', 'https://fonts.googleapis.com/...', [], null );
} );
```

### `inc/data.php`

Transcribe every file in `_data_source/` into a PHP function. Example
for `_data_source/menu.yml`:

```php
<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

function {{THEME_SLUG}}_data_menu() {
    return [
        [ 'title' => 'About',  'url' => '/about/' ],
        [ 'title' => 'Blog',   'url' => '/blog/' ],
        [ 'title' => 'Contact', 'url' => '/contact/' ],
    ];
}
```

One getter per file, named `{{THEME_SLUG}}_data_<basename>()`.

---

## Scope

- Write allowed: only inside `{{THEME_DIR}}`.
- Read allowed: anything under `{{SOURCE_DIR}}` and `{{THEME_DIR}}`.
- Do not touch the plugin directory, the content directory, wp-env, or
  the database.

## Theme metadata

- Theme slug: `{{THEME_SLUG}}`
- Site title: `{{SITE_TITLE}}`
- Text domain: `{{THEME_SLUG}}`

## Source kind

**`{{SOURCE_KIND}}`**. Detector briefing:

> {{DETECTOR_BRIEFING}}

## Ground-truth reference

{{RENDERED_REFERENCE}}

## Mirrored source (for reference — do not publish)

{{MIRRORED_SOURCE}}

## Detected context

```json
{{DETECTED_JSON}}
```

## Pages to render

{{PAGES_TABLE}}

- Front page slug: `{{FRONT_PAGE_SLUG}}` → renders at `/`.
- Blog index page slug: `{{BLOG_INDEX_PAGE_SLUG}}`.
- Privacy policy page slug: `{{PRIVACY_PAGE_SLUG}}`.

---

## Pixel-fidelity loop

After your first pass, the tool activates this theme, fetches the live
home page, and diffs it structurally against the source. Gaps (missing
hero, wrong class list, missing menu item, empty body) trigger a
**theme-refine** pass up to 3 times. Aim for zero gaps on the first
pass — that's the fastest path through the loop.

**Do not** skip the hero, placeholder the menu, or drop images. Use
`inc/data.php` as the authoritative source for menu and author data
since `wp:navigation` requires a menu ref that doesn't exist on first
boot.

---

## Fidelity rules (non-negotiable)

1. **DOM match**: every class string in the rendered reference must
   appear in your block markup. Use `className` attribute on blocks.
2. **Escaping in PHP** (patterns, dynamic blocks, inc/*):
   - `esc_html` for text, `esc_attr` for attributes, `esc_url` for URLs
   - `wp_kses_post` for HTML content
   - Never echo raw user data or raw data from files
3. **Asset URLs**: use `get_template_directory_uri()` in PHP patterns;
   in HTML templates, put asset URLs in block attributes (they resolve
   relative to the theme root).
4. **External links**: `href` starting with `http://`, `https://`,
   `mailto:`, `tel:`, `//`, or `#` must be output verbatim. Do NOT
   prepend `home_url()`.
5. **i18n**: every user-visible string in PHP uses `__()` / `esc_html__()`
   with text domain `{{THEME_SLUG}}`.
6. **Plugin concerns stay out**: dark mode, cookie banner, giscus,
   analytics, newsletter, custom URL endpoints (e.g. /llm/) belong in
   the plugin. In the theme, emit `do_action('{{THEME_SLUG}}/…')` hooks
   where the source includes those features.

---

## Style hierarchy (critical to know)

WordPress applies styles in this order: **core defaults → theme.json →
child theme → user customizations**. User global styles (saved in the
DB via the Site Editor) override everything else. If users customized
the default theme, your `theme.json` changes may appear to not apply
on sites with previous customizations — this is expected. Our fresh
migration has no prior customizations, so your `theme.json` will be
authoritative.

---

## Self-check (walk every item before stopping)

- [ ] **No forbidden files**: no `header.php`, `footer.php`, `index.php`,
      `single.php`, `page.php`, `archive.php`, `search.php`, `404.php`,
      `front-page.php`, or `home.php` anywhere.
- [ ] `theme.json` has `"version": 3` and `"$schema"`.
- [ ] `theme.json.settings.color.palette` populated from `detected.colors`.
- [ ] `theme.json.settings.typography.fontFamilies` from `detected.fonts`.
- [ ] `theme.json.templateParts` registers every `.html` in `parts/`.
- [ ] `theme.json.customTemplates` registers every `page-*.html` in `templates/`.
- [ ] `templates/` has `index.html`, `single.html`, `page.html`,
      `archive.html`, `search.html`, `404.html`.
- [ ] `parts/` is flat (no nested subdirectories) and has at least
      `header.html` and `footer.html`.
- [ ] `style.css` > 5 KB and has a complete theme header.
- [ ] `functions.php` only registers support/menus and requires includes.
- [ ] Every `.php` file starts with `if ( ! defined( 'ABSPATH' ) ) { exit; }`.
- [ ] `inc/data.php` exports a getter for every `_data_source/` file.
- [ ] Every dynamic block has `apiVersion: 3`.
- [ ] No `localhost` URLs, no TODOs, no placeholder strings.
