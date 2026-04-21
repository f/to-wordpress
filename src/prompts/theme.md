{{SHARED}}

## Phase: Theme

Produce a self-contained classic WordPress theme that reproduces the source
site **byte-close**: same DOM, same class names, same text, same images,
same CSS, same fonts. Verify will fetch the live WP pages and diff them
against the rendered reference below — a mismatched hero heading, missing
image, empty menu, or swapped class list is a hard failure.

## Scope

- Write allowed: only inside `{{THEME_DIR}}`.
- Read allowed: anything under `{{SOURCE_DIR}}` and `{{THEME_DIR}}`.
- Do not touch the plugin directory, the content directory, wp-env, or
  the database.

## Theme metadata

- Theme slug: `{{THEME_SLUG}}`
- Site title: `{{SITE_TITLE}}`
- Text domain: `{{THEME_SLUG}}` (use this identifier for every `__()`,
  `_e()`, `_x()`, etc.)

## Source kind

This source was identified as **`{{SOURCE_KIND}}`**. The detector's
briefing (read this BEFORE anything else — it tells you what to
produce for this particular source shape):

> {{DETECTOR_BRIEFING}}

## Ground-truth reference

{{RENDERED_REFERENCE}}

## Mirrored source (inside the theme dir, do not publish these)

{{MIRRORED_SOURCE}}

Detected context (JSON):

```json
{{DETECTED_JSON}}
```

## Standalone pages (one template per source layout)

{{PAGES_TABLE}}

- Front page slug: `{{FRONT_PAGE_SLUG}}` → WordPress renders this at `/` via `front-page.php` (MUST exist and reproduce the source hero exactly).
- Blog index page slug: `{{BLOG_INDEX_PAGE_SLUG}}` → WordPress renders this at whatever URL the page lives at, using `home.php` for the posts loop.
- Privacy policy page slug: `{{PRIVACY_PAGE_SLUG}}` → regular `page.php` or `page-basic.php` if present.

For **every distinct source layout** listed in the table above, create
`page-<layout>.php` (or `page-templates/<layout>.php`) in the theme root.
Each file MUST declare a `Template Name` header so the WordPress editor
lists it:

```php
<?php
/**
 * Template Name: <Layout Name>
 * Template Post Type: page
 */
get_header(); ?>
…
<?php get_footer();
```

The Import phase reads each page's source `layout` and sets
`_wp_page_template` to the matching file. Missing a template → the page
silently falls back to `page.php` and loses fidelity. A page whose
layout is `categories` MUST have a `page-categories.php` that renders
the site's category index exactly as the source did.

## Required output (every file must exist and be non-empty)

### Top-level

- `style.css` — full theme header + compiled stylesheet.
  - Header MUST include: `Theme Name`, `Version`, `License`, `Text Domain:
    {{THEME_SLUG}}`, `Description`.
  - Compile every `.scss` under `_sass_source/` into this file (or into a
    sibling file that `style.css` `@import`s). Preserve every selector
    the source used; the rendered reference CSS was compiled from the
    same Sass.
- `theme.json` — keep the seeded palette + fonts; add any missing color
  tokens present in `detected.colors` and font families in
  `detected.fonts`.
- `functions.php` — see rules below.
- `inc/data.php` — PHP transcription of every file in `_data_source/`
  (menu, social, authors, partners, contact, any others). Expose getters
  named `{{THEME_SLUG}}_data_<name>()` returning plain arrays. No
  runtime YAML parsing.
- `inc/enqueue.php` — style + script + font enqueueing (included from
  `functions.php`).
- `inc/template-tags.php` — reusable template helpers (no business logic).
- `screenshot.png` — copy any `assets/images/og/og-*.webp` or homepage
  image into PNG at 1200×900 if available, else skip.

### Templates

- `header.php`, `footer.php`, `sidebar.php`, `searchform.php`, `comments.php`
- `index.php` (fallback listing), `home.php` (blog listing at `/blog/`),
  `front-page.php` (home at `/`), `single.php`, `page.php`, `archive.php`,
  `category.php`, `search.php`, `404.php`.
- `taxonomy-<slug>.php` for every custom taxonomy implied by
  `detected.frontMatterKeys`.
- `single-<cpt>.php` for every entry in `detected.collections` whose
  `name != 'posts'`.

### Template parts

For every file under `_source_includes/` create a matching part under
`template-parts/<same/relative/path>.php`. Example:
`_source_includes/framework/header.html` →
`template-parts/framework/header.php`.

Call parts from templates with:

```php
get_template_part(
    'template-parts/framework/title',
    null,
    [ 'title' => get_the_title(), 'image' => get_post_meta( get_the_ID(), 'image', true ) ]
);
```

Parts read their arguments from `$args` (WP ≥ 5.5).

## Non-negotiable fidelity rules

1. **HTML in titles.** Source page/post titles may contain `<em>`,
   `<strong>`, `<code>`, `<br>`, `<a>`, etc. Render titles with
   `<?php echo wp_kses_post( get_the_title() ); ?>`. Never use
   `esc_html(get_the_title())` in a template — that would strip the tags
   and break heroes.
2. **Featured image.** Render `<img src="…" alt="…" />` exactly where the
   source renders `{{ page.image }}` / `{{ post.image }}`. Source of the
   URL, in priority order: `get_the_post_thumbnail_url(null, 'full')`,
   then `get_post_meta($id, 'featured_image', true)`. If neither exists,
   omit the tag — do not render a broken `src=""`.
3. **Menu.** The primary nav in `header.php` must do both:
   - Call `wp_nav_menu(['theme_location' => 'primary', 'fallback_cb' => false, 'container' => false])`.
   - If `wp_nav_menu` returns empty, fall back to rendering the static
     array returned by `{{THEME_SLUG}}_data_menu()` with the same markup
     the source used. The header must never look empty on first boot.
4. **Classes.** Every class string in the rendered reference (body,
   section wrappers, column widths, button states) must appear in the
   same order in your PHP output. Do not invent or omit classes.
5. **Image URLs.** Any `/assets/…` path in the reference becomes
   `<?php echo esc_url( get_template_directory_uri() ); ?>/assets/…`.
5a. **External links.** Any `href` that starts with `http://`, `https://`,
   `mailto:`, `tel:`, `//`, or `#` MUST be output verbatim through
   `esc_url($url)`. Do NOT prepend `home_url()`, `site_url()`, or a
   relative base, and do NOT concatenate `./` in front of them. Only
   SITE-RELATIVE paths (`/about/`, `posts/foo/`) get wrapped with
   `home_url()`. A menu item whose data URL is `https://github.com/foo`
   must render as `href="<?php echo esc_url( $item['url'] ); ?>"` with
   no base, not `href="./<?php ... ?>"` and not `home_url('https://…')`.
6. **i18n.** Every user-visible string goes through `__()` or `esc_html__()`
   with text domain `{{THEME_SLUG}}`. Do not translate dynamic strings.
7. **Escaping.** Output escaping is mandatory: `esc_html` for text,
   `esc_attr` for attributes, `esc_url` for URLs, `wp_kses_post` only
   where HTML is expected (titles, content, cards). Never echo raw user
   data.
8. **Dark mode, cookie banner, giscus, analytics, newsletter** belong in
   the plugin. In the theme emit the matching `do_action` hooks where the
   source includes those features (e.g. `do_action('{{THEME_SLUG}}/after_header')`,
   `do_action('{{THEME_SLUG}}/giscus')`). Do NOT implement these in the
   theme.
9. **Loops.** Jekyll `{% for post in paginator.posts %}` becomes a
   `WP_Query` with `paged = max(1, (int) get_query_var('paged'))`.
   Pagination MUST use `paginate_links()` with classes that match the
   source pagination markup.
10. **Shortcodes & blocks.** Shortcodes referenced by the source
    (`{% include shortcodes/button.html %}`) are registered by the plugin.
    Theme templates call them via `do_shortcode()` when appropriate. Never
    reimplement a shortcode here.

## Liquid → PHP cheat sheet

| Liquid | PHP |
|---|---|
| `{{ page.title }}` | `<?php echo wp_kses_post( get_the_title() ); ?>` |
| `{{ page.description }}` | `<?php echo wp_kses_post( get_the_excerpt() ); ?>` |
| `{{ page.image }}` | `<?php echo esc_url( get_the_post_thumbnail_url( null, 'full' ) ?: get_post_meta( get_the_ID(), 'featured_image', true ) ); ?>` |
| `{{ content }}` | `<?php the_content(); ?>` |
| `{{ site.title }}` | `<?php bloginfo('name'); ?>` |
| `{{ site.url }}` | `<?php echo esc_url( home_url() ); ?>` |
| `{{ post.url }}` | `<?php the_permalink(); ?>` |
| `{{ post.date \| date: '%b %d, %Y' }}` | `<?php echo esc_html( get_the_date('M j, Y') ); ?>` |
| `{% include framework/header.html ... %}` | `get_template_part('template-parts/framework/header', null, [...])` |
| `{% for post in paginator.posts %}` | `WP_Query` loop + `paginate_links()` |
| `{{ site.data.menu }}` | `{{THEME_SLUG}}_data_menu()` |
| `{% if jekyll.environment == 'production' %}` | `<?php if ( ! WP_DEBUG ) : ?>` |

## Enqueue rules

In `inc/enqueue.php`:

- Register every stylesheet with a versioned handle
  (`wp_get_theme()->get('Version')`).
- Google Fonts are loaded once with `display=swap` per
  `detected.fonts.google_fonts_url`.
- JS goes in the footer (`in_footer = true`).
- Do not enqueue jQuery unless a template actually needs it.

## Workflow you MUST follow

1. Read the rendered reference HTML samples for `/`, `/blog/`, a single
   post, a page, and a category.
2. Open every `.html` in `_source_layouts/` and `_source_includes/`. For
   each include, create the matching `template-parts/.../<name>.php`.
3. Compile `_sass_source/` into `style.css`. Shell out to `sass` (dart
   sass) if installed; otherwise transcribe the SCSS imports manually
   (every `@import` in `_sass_source/style.scss` becomes a concatenated
   block in `style.css` in the same order).
4. Transcribe `_data_source/*.{yml,yaml,json}` into
   `inc/data.php`. One getter per file.
5. Write every template. For each, fetch the matching reference HTML and
   compare your output structurally (DOM + classes + visible text).
6. Run a final pass to ensure every `Required output` file exists and
   every `Self-check` item passes.

## Self-check (walk every item before you stop)

- [ ] All "Required output" files exist and are non-empty.
- [ ] `style.css` is > 5 KB (a real compiled stylesheet, not just a
      header block).
- [ ] `inc/data.php` exports a getter for every file in `_data_source/`.
- [ ] `header.php` outputs the same DOM structure as the reference
      `<body>` head, with the same classes, menu items, and logo tags.
- [ ] `front-page.php` outputs the hero H1 with its HTML tags preserved
      and the featured image from `/assets/…`.
- [ ] Every Liquid `{% include … %}` in the source has a
      `template-parts/…/<name>.php` counterpart.
- [ ] No template passes a title through `esc_html`.
- [ ] No placeholder strings, no hard-coded `localhost` URLs, no TODOs.
- [ ] Every user-visible string uses text domain `{{THEME_SLUG}}`.
