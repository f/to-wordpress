{{SHARED}}

## Phase: Theme (Block / FSE)

Produce a **block theme** (Full Site Editing) that reproduces the source
site with high fidelity: same DOM structure, same class names, same text,
same images, same CSS, same fonts. Verify will fetch the live WP pages
and diff them against the rendered reference — a mismatched hero heading,
missing image, empty menu, or swapped class list is a hard failure.

**You MUST produce a block theme.** This means:

- Templates live in `templates/*.html` as block markup (not PHP files).
- Template parts live in `parts/*.html` as block markup.
- `theme.json` is the single source of truth for styles, colors, fonts,
  spacing, layout, and template/part registration.
- No `header.php`, `footer.php`, `index.php`, `single.php` etc. in the
  root — those are classic theme files and MUST NOT exist.
- `functions.php` only handles enqueuing, nav menus, theme support, and
  data helpers — no template rendering logic.
- `style.css` contains the theme header comment and compiled styles.

**Pixel-fidelity loop.** Immediately after your first pass the tool
activates this theme on the live WordPress, fetches
`http://localhost:8888/`, and computes a structural diff against the
source-rendered home page. Every mismatch is fed back to a
**theme-refine** step up to three times. So:

- Do NOT skip the hero. The home page `<h1>` MUST match the reference.
- Do NOT emit placeholder nav. Use the static menu data if `wp_nav_menu`
  isn't populated yet.
- Do NOT drop images from the hero, cards, or footer.
- Aim for zero gaps on the first pass.

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

This source was identified as **`{{SOURCE_KIND}}`**. The detector's
briefing:

> {{DETECTOR_BRIEFING}}

## Ground-truth reference

{{RENDERED_REFERENCE}}

## Mirrored source (inside the theme dir, do not publish these)

{{MIRRORED_SOURCE}}

Detected context (JSON):

```json
{{DETECTED_JSON}}
```

## Standalone pages

{{PAGES_TABLE}}

- Front page slug: `{{FRONT_PAGE_SLUG}}` → WordPress renders at `/`.
- Blog index page slug: `{{BLOG_INDEX_PAGE_SLUG}}` → blog listing.
- Privacy policy page slug: `{{PRIVACY_PAGE_SLUG}}`.

For **every distinct source layout** in the table, create a matching
block template in `templates/page-<layout>.html`. Register it in
`theme.json` under `customTemplates` so the editor lists it:

```json
{
  "customTemplates": [
    { "name": "page-<layout>", "title": "<Layout Name>", "postTypes": ["page"] }
  ]
}
```

## Required output — block theme structure

### `theme.json` (the heart of the theme)

Version 2+ schema. Must include:

- `settings.color.palette` — from `detected.colors`
- `settings.typography.fontFamilies` — from `detected.fonts`
- `settings.layout` — content and wide widths matching the source
- `templateParts` — register every part: `header`, `footer`, `sidebar`,
  and any custom parts matching source includes
- `customTemplates` — register every page template
- `styles` — global element styles (body, headings, links, buttons)
  matching the source CSS

### `style.css`

Theme header comment (Theme Name, Version, etc.) plus compiled styles.
Compile every `.scss` under `_sass_source/` into this file. Must be > 5 KB.

### `functions.php`

- `add_theme_support('wp-block-styles')` — NOT `title-tag` (block themes
  get that automatically).
- `register_nav_menus` for primary + footer.
- `wp_enqueue_style` for the main stylesheet.
- Google Fonts via `wp_enqueue_style` with `display=swap`.
- `inc/data.php` — PHP transcription of `_data_source/` files with
  getters: `{{THEME_SLUG}}_data_<name>()`.
- `inc/enqueue.php` — style + font + script loading.
- `inc/template-tags.php` — helper functions called from block templates
  via `render_callback` or `do_action` hooks.
- `inc/blocks.php` — register any theme-specific block patterns or
  dynamic blocks.

### `templates/` — block templates (HTML)

Every template is HTML with block comments. Example:

```html
<!-- wp:template-part {"slug":"header","tagName":"header"} /-->
<!-- wp:group {"tagName":"main","className":"site-main"} -->
<main class="wp-block-group site-main">
  <!-- wp:post-content /-->
</main>
<!-- /wp:group -->
<!-- wp:template-part {"slug":"footer","tagName":"footer"} /-->
```

Required templates:

- `templates/index.html` — fallback
- `templates/front-page.html` — home at `/` (hero, cards, etc.)
- `templates/home.html` — blog listing with query loop
- `templates/single.html` — single post
- `templates/page.html` — single page
- `templates/archive.html` — category/tag/date archives
- `templates/search.html` — search results
- `templates/404.html` — not found
- `templates/page-<layout>.html` — one per distinct source layout

### `parts/` — template parts (HTML)

- `parts/header.html` — site header with nav menu
- `parts/footer.html` — site footer
- `parts/sidebar.html` — if source has a sidebar

For every file under `_source_includes/` create a matching part or
pattern. Example: `_source_includes/framework/header.html` →
`parts/header.html`.

### Block patterns

For complex reusable sections (hero, card grid, CTA), register them as
block patterns in `inc/blocks.php` using `register_block_pattern`.

## Block template cheat sheet

| Source construct | Block theme equivalent |
|---|---|
| `{{ page.title }}` | `<!-- wp:post-title {"level":1} /-->` |
| `{{ content }}` | `<!-- wp:post-content /-->` |
| `{{ page.image }}` | `<!-- wp:post-featured-image /-->` |
| `{{ page.date }}` | `<!-- wp:post-date /-->` |
| `{{ page.author }}` | `<!-- wp:post-author /-->` |
| `{{ page.excerpt }}` | `<!-- wp:post-excerpt /-->` |
| `{% include header %}` | `<!-- wp:template-part {"slug":"header"} /-->` |
| Blog post loop | `<!-- wp:query --><!-- wp:post-template -->…<!-- /wp:post-template --><!-- wp:query-pagination /--><!-- /wp:query -->` |
| Category listing | `<!-- wp:query {"queryId":1,"query":{"perPage":12}} -->` |
| Nav menu | `<!-- wp:navigation {"ref":0} /-->` or dynamic via `functions.php` |
| Site title | `<!-- wp:site-title /-->` |
| Site logo | `<!-- wp:site-logo /-->` |

**For custom/dynamic sections** that blocks can't express (data-driven
menus, custom queries, shortcode output), use a **dynamic block** or
`do_shortcode()` inside a Custom HTML block, or register a
`render_callback` block in `inc/blocks.php`.

## Non-negotiable fidelity rules

1. **HTML in titles.** Source titles may contain `<em>`, `<strong>`, etc.
   Use `wp:post-title` which preserves HTML, or a custom block with
   `wp_kses_post`.
2. **Featured image.** Use `wp:post-featured-image` or custom block that
   reads post meta `featured_image`.
3. **Menu.** The header part must include navigation. If `wp:navigation`
   can't render (no menu assigned yet), have `functions.php` register a
   fallback via the static data from `inc/data.php`.
4. **Classes.** Every class string in the rendered reference must appear
   in your block markup. Use `className` attribute on blocks.
5. **Image URLs.** `/assets/…` paths resolve via theme URI. Use custom
   blocks or patterns with
   `<?php echo esc_url( get_template_directory_uri() ); ?>`.
6. **External links.** `href` starting with `http://`, `https://`,
   `mailto:`, `tel:`, `//`, or `#` must be output verbatim.
7. **i18n.** User-visible strings in PHP use `__()` with `{{THEME_SLUG}}`.
8. **Escaping.** `esc_html` for text, `esc_attr` for attributes,
   `esc_url` for URLs, `wp_kses_post` for HTML content.
9. **Plugin concerns.** Dark mode, cookie banner, giscus, analytics,
   newsletter, custom endpoints belong in the plugin. In the theme emit
   `do_action('{{THEME_SLUG}}/after_header')` etc. where needed.
10. **Shortcodes.** Source shortcodes are registered by the plugin. In
    templates, use Custom HTML blocks with `[shortcode]` syntax.

## Workflow

1. Read the rendered reference HTML samples.
2. Open every `.html` in `_source_layouts/` and `_source_includes/`.
3. Compile `_sass_source/` into `style.css`.
4. Transcribe `_data_source/` into `inc/data.php`.
5. Write `theme.json` with full settings, template parts, and custom
   templates.
6. Write every block template in `templates/` and `parts/`.
7. Write `functions.php` + includes.
8. Final pass: every required file exists, self-check passes.

## Self-check

- [ ] **No classic template files** in theme root (`header.php`,
      `footer.php`, `index.php`, `single.php`, `page.php` etc. must NOT
      exist — only `functions.php` and `style.css`).
- [ ] `theme.json` version ≥ 2 with `templateParts` and
      `customTemplates`.
- [ ] `templates/` has `index.html`, `front-page.html`, `home.html`,
      `single.html`, `page.html`, `archive.html`, `404.html`.
- [ ] `parts/` has at least `header.html` and `footer.html`.
- [ ] `style.css` is > 5 KB.
- [ ] `inc/data.php` exports a getter for every `_data_source/` file.
- [ ] No placeholder strings, no `localhost` URLs, no TODOs.
