{{SHARED}}

## Phase: Theme (Classic PHP + Shortcodes)

Produce a **classic WordPress theme** that reproduces the source site UI
with high fidelity. Do **not** produce a block theme. Do **not** create
`templates/*.html`, `parts/*.html`, `patterns/*.php`, or dynamic blocks
inside the theme. LLMs are more reliable when they can translate source
layouts directly into PHP templates and template parts, so this phase
must stay classic.

The plugin phase owns reusable shortcodes, custom endpoints, comments,
analytics, cookie banner, dark mode, and other non-theme behavior. The
theme calls those plugin features through `do_action()` and shortcode
syntax; it does not implement them.

---

## Visual fidelity is the primary deliverable

This phase is not "make a valid WordPress theme." It is "make WordPress
render the same UI as the source." A valid theme that looks generic,
drops sections, changes spacing, loses cards, flattens navigation,
changes typography, or omits responsive behavior is a failure.

Before writing files, build a private working inventory from the source
rendered reference and templates:

1. **Page-type inventory**: home/front page, blog index + pagination,
   single post, static page layouts, category/tag/archive, search, 404.
2. **Section inventory**: header, logo, nav, hero, cards, metadata,
   sidebars, post body, related/nav links, newsletter, comments, footer.
3. **Design tokens**: colors, fonts, weights, sizes, line height,
   spacing scale, breakpoints, radii, borders, shadows, image ratios.
4. **Assets**: every image, SVG/logo, font, CSS, JS file referenced by
   the rendered source HTML.
5. **Dynamic behavior**: mobile nav, dark mode toggle, comments hook,
   newsletter hook, cookie banner hook, analytics hook.

Use the inventory to decide which source files become PHP templates,
which become `template-parts/*.php`, which become plugin shortcodes,
and which belong in `style.css` / `inc/data.php`. Do not discard a
source UI section.

---

## Scope

- Write allowed: only inside `{{THEME_DIR}}`.
- Read allowed: anything under `{{SOURCE_DIR}}` and `{{THEME_DIR}}`.
- Do not touch the plugin directory, content directory, wp-env, or DB.

## Theme metadata

- Theme slug: `{{THEME_SLUG}}`
- Site title: `{{SITE_TITLE}}`
- Text domain: `{{THEME_SLUG}}`

## Source kind

Source was identified as **`{{SOURCE_KIND}}`**. Detector briefing:

> {{DETECTOR_BRIEFING}}

## Ground-truth reference

{{RENDERED_REFERENCE}}

## Mirrored source

{{MIRRORED_SOURCE}}

Detected context:

```json
{{DETECTED_JSON}}
```

## Standalone pages

{{PAGES_TABLE}}

- Front page slug: `{{FRONT_PAGE_SLUG}}` → render at `/` via
  `front-page.php`.
- Blog index page slug: `{{BLOG_INDEX_PAGE_SLUG}}` → render via
  `home.php` using the WordPress posts loop.
- Privacy policy page slug: `{{PRIVACY_PAGE_SLUG}}` → `page.php` or
  matching `page-<layout>.php`.

For every distinct source layout, create `page-<layout>.php` in the
root. Each must declare a template header:

```php
<?php
/**
 * Template Name: <Layout Name>
 * Template Post Type: page
 */
get_header();
?>
...
<?php get_footer();
```

---

## Required output

### Top level files

- `style.css` — complete theme header and compiled CSS.
- `functions.php` — theme support, menus, enqueue includes, helper loads.
- `theme.json` — optional but useful for editor palettes/fonts; do not
  rely on it for rendering.
- `header.php`, `footer.php`, `index.php`, `front-page.php`, `home.php`,
  `single.php`, `page.php`, `archive.php`, `category.php`, `search.php`,
  `404.php`.
- `comments.php` if source comments require a template location.
- `searchform.php` if source has custom search markup.
- `screenshot.png` if an obvious source image exists.

### Includes

- `inc/data.php` — PHP transcription of every `_data_source/*` file.
  Provide getters named `{{THEME_SLUG}}_data_<name>()` returning arrays.
- `inc/enqueue.php` — enqueue stylesheet, fonts, and theme JS.
- `inc/template-tags.php` — rendering helpers and small reusable functions.

### Template parts

For every significant source include under `_source_includes/`, create
one matching PHP file under `template-parts/`:

| Source include | Theme part |
|---|---|
| `_source_includes/framework/header.html` | `template-parts/framework/header.php` |
| `_source_includes/framework/footer.html` | `template-parts/framework/footer.php` |
| `_source_includes/**/card*.html` | `template-parts/**/card*.php` |
| `_source_includes/**/pagination*.html` | `template-parts/**/pagination*.php` |
| `_source_includes/**/author*.html` | `template-parts/**/author*.php` |

Call them with:

```php
get_template_part('template-parts/framework/header', null, [
    'menu' => {{THEME_SLUG}}_data_menu(),
]);
```

Inside parts, read data from `$args` and escape everything.

---

## Source-to-WordPress mapping contract

| Source UI file | Classic theme artifact |
|---|---|
| `_layouts/default.html` | `header.php`, `footer.php`, `index.php` |
| `_layouts/home.html` | `front-page.php` |
| `_layouts/blog*.html` | `home.php` + card template part |
| `_layouts/post*.html` | `single.php` |
| `_layouts/basic/contact/categories.html` | `page-<layout>.php` |
| `_layouts/category.html` | `category.php` / `archive.php` |
| `_includes/framework/header.html` | `header.php` or `template-parts/framework/header.php` |
| `_includes/framework/footer.html` | `footer.php` or `template-parts/framework/footer.php` |
| `_includes/**/shortcodes/*.html` | plugin shortcodes; theme may style shortcode output |
| `_sass/**/*.scss` | compiled into `style.css` preserving selectors |
| `_data/*.yml/json` | `inc/data.php` getters and menu fallbacks |

If a source layout/include does not map cleanly, create a PHP template
part. Never drop it.

---

## WordPress rendering rules

1. **HTML in titles**: use `wp_kses_post( get_the_title() )`, never
   `esc_html( get_the_title() )`, because source titles may contain
   `<em>`, `<strong>`, `<code>`, `<br>`, etc.
2. **Content**: use `the_content()` for imported content. Shortcodes
   generated by normalize/plugin must render through WordPress shortcode
   handlers.
3. **Featured image**: use `get_the_post_thumbnail_url(null, 'full')`,
   then post meta `featured_image` / `image` fallback.
4. **Menus**: call `wp_nav_menu()` for assigned menus; if empty, fall
   back to `{{THEME_SLUG}}_data_menu()` so first render is not blank.
5. **External links**: if URL starts with `http://`, `https://`,
   `mailto:`, `tel:`, `//`, or `#`, output verbatim through `esc_url()`;
   do not prepend `home_url()`.
6. **Internal links**: source-relative paths like `/blog/` use
   `home_url('/blog/')`.
7. **Assets**: `/assets/...` becomes
   `get_template_directory_uri() . '/assets/...'`.
8. **Plugin hooks**: emit theme hooks where source had non-theme
   behavior:
   - `do_action('{{THEME_SLUG}}/after_header')`
   - `do_action('{{THEME_SLUG}}/newsletter')`
   - `do_action('{{THEME_SLUG}}/dark_mode_toggle')`
   - `do_action('{{THEME_SLUG}}/comments')`
   - `do_action('{{THEME_SLUG}}/cookie_banner')`
9. **Escaping**: `esc_html`, `esc_attr`, `esc_url`, `wp_kses_post` as
   appropriate. Never echo raw front matter or raw `_data` values.
10. **i18n**: every literal user-facing string uses text domain
    `{{THEME_SLUG}}`.

---

## Shortcodes instead of blocks

Reusable content pieces stay as shortcodes, not Gutenberg blocks.

- The normalize phase rewrites Liquid includes into `[towp_<name> ...]`.
- The plugin phase registers every `[towp_<name>]` handler.
- The theme must style the shortcode output in `style.css` and may call
  shortcodes in templates via `do_shortcode()` where the source layout
  inserted reusable fragments.
- Do **not** generate `block.json`, `edit.js`, `render.php`, or block
  directories from the theme prompt.

Example template usage:

```php
<?php echo do_shortcode('[towp_newsletter]'); ?>
```

---

## Loop + pagination rules

- Blog index (`home.php`) uses `WP_Query` / main loop with `paged`.
- Pagination uses `paginate_links()` but must match source classes and
  structure.
- Category archive (`category.php`) uses the main archive query and
  source category layout/classes.
- Search results use the source search/card structure.
- 404 uses source 404 layout if present; otherwise create a faithful
  page using source typography/navigation/footer.

---

## Workflow

1. Read rendered reference HTML samples for `/`, `/blog/`, a single
   post, a page, a category page.
2. Open every `_source_layouts/*.html` and `_source_includes/**/*.html`.
3. Build a mapping from every source layout/include to a PHP file.
4. Compile `_sass_source/` into `style.css`; preserve source selectors.
5. Transcribe `_data_source/` into `inc/data.php`.
6. Write templates and parts.
7. Check every required file exists and no source section was dropped.

---

## Self-check

- [ ] All required classic theme files exist and are non-empty.
- [ ] No `templates/*.html`, `parts/*.html`, `patterns/*.php`, or block
      directories were created.
- [ ] Every `_layouts/*.html` maps to a PHP template or composition.
- [ ] Every important `_includes/*.html` maps to a template part, hook,
      shortcode styling, or helper.
- [ ] Header/nav/footer visually match source at desktop and mobile.
- [ ] Home hero, blog cards, post header, category archive, and static
      page layouts structurally match rendered references.
- [ ] Source images are present with correct aspect ratio and alt text.
- [ ] Source typography, colors, spacing, radii, shadows, hover/focus
      states are represented in CSS.
- [ ] No title uses `esc_html( get_the_title() )`.
- [ ] No placeholder text, TODOs, or localhost URLs.
