{{SHARED}}

## Phase: Pluginize

Produce a single site-specific WordPress plugin that owns everything
"non-theme" about the source site: custom post types, custom taxonomies,
custom blocks/shortcodes, comments integration, newsletter, analytics,
cookie banner, and the redirects map. These concerns must survive a theme
change; they do NOT belong in the theme.

## Scope

- Write allowed: only inside `{{PLUGIN_DIR}}`.
- Read allowed: anything under `{{SOURCE_DIR}}` and `{{PLUGIN_DIR}}`.
- Do NOT touch the theme directory, the content directory, or the
  database.

## Plugin metadata

- Plugin slug: `{{PLUGIN_SLUG}}`
- Prefix: `wpify` for neutral helpers, `{{PLUGIN_SLUG_UNDERSCORED}}` for
  plugin-specific identifiers (functions, hooks, options, post meta,
  block names). (Derive the underscored form from the slug: replace `-`
  with `_`.)

## Inputs

Source kind: **`{{SOURCE_KIND}}`**. Detector briefing (read first):

> {{DETECTOR_BRIEFING}}

Detected context:

```json
{{DETECTED_JSON}}
```

User choices:

```json
{{CHOICES_JSON}}
```

## Required output

### Bootstrap

- `{{PLUGIN_SLUG}}.php` — only the WordPress plugin header comment and a
  `foreach` that `require_once`'s every `includes/*.php`. Standard header
  fields, with HUMAN-READABLE metadata (WordPress's plugin list displays
  `Plugin Name` as-is):
  - `Plugin Name: {{SITE_TITLE}} Site` (e.g. if the migrated site title is
    "F. Kadev", use `Plugin Name: F. Kadev Site`). Never emit the raw
    slug as the plugin name.
  - `Plugin URI`, `Description: Site-specific plugin for {{SITE_TITLE}} —
    CPTs, shortcodes, analytics, redirects, and other non-theme features
    migrated by to-wordpress.`,
  - `Version: 0.1.0`, `Requires at least: 6.3`, `Requires PHP: 8.1`,
  - `License: GPL-2.0-or-later`, `Text Domain: {{PLUGIN_SLUG}}`.
  Guard with `if ( ! defined( 'ABSPATH' ) ) { exit; }`.
- `readme.txt` — standard WP plugin readme with Stable tag `0.1.0`.
- `uninstall.php` — deletes plugin options + CPT/meta registered here
  when the plugin is deleted.

### Feature includes

Create one file under `includes/` for **every** matched feature below.
Omit a file only when the corresponding detected input is empty — never
emit a stub.

| feature | include file | trigger (detected input) |
|---|---|---|
| Custom post types | `includes/cpt.php` | any entry in `choices.customPostTypes` |
| Taxonomies | `includes/taxonomies.php` | custom taxonomies in detected front-matter |
| Newsletter | `includes/newsletter.php` | `features.newsletterFormAction` |
| Giscus comments | `includes/comments-giscus.php` | `features.giscusRepo` |
| Disqus comments | `includes/comments-disqus.php` | `features.disqusShortname` |
| Commento comments | `includes/comments-commento.php` | `features.commentoEnabled` |
| Google Analytics | `includes/analytics-ga.php` | `features.googleAnalyticsId` |
| Google Tag Manager | `includes/analytics-gtm.php` | `features.gtmId` |
| Plausible | `includes/analytics-plausible.php` | `features.plausibleDomain` |
| Umami | `includes/analytics-umami.php` | `features.umamiWebsiteId` |
| Cookie banner | `includes/cookie-banner.php` | `features.cookieBanner` |
| Dark mode | `includes/dark-mode.php` | `features.darkMode` |
| Open Graph / Twitter Card | `includes/social-meta.php` | `features.twitterSite` / `features.twitterCreator` / `features.metaOpengraphType` |
| Redirects | `includes/redirects.php` | always |
| Shortcodes | `includes/shortcodes.php` | if `_source_includes/shortcodes/*` exists |
| Blocks | `includes/blocks.php` + `includes/blocks/<name>/` | if `.prompt.yml` files exist, or source has interactive blocks |
| Options page | `includes/options.php` | always (see below) |
| Data loader | `includes/data.php` | if plugin needs `_data/*` server-side |

### Implementation rules per feature

**Custom post types** (`cpt.php`):

For every entry in `choices.customPostTypes` call `register_post_type` on
the `init` hook with:

- `public = true`, `show_in_rest = true`, `has_archive = true`,
- `supports = ['title','editor','excerpt','thumbnail','custom-fields','author','comments','revisions']`,
- `rewrite = ['slug' => <pathPrefix or slug>, 'with_front' => false]`.
- `labels` must be fully populated (not auto-generated).
- Flush rewrite rules once on activation via
  `register_activation_hook`.

**Taxonomies** (`taxonomies.php`):

Register any non-default taxonomies the source used. Attach them to the
correct post types. `hierarchical` = true for `categories`, false for
`tags`.

**Newsletter** (`newsletter.php`):

- Register shortcode `[{{PLUGIN_SLUG_UNDERSCORED}}_newsletter]`.
- Expose hook `do_action('{{THEME_SLUG}}/newsletter')` the theme can call.
- Render a Mailchimp-style form posting to the URL from
  `features.newsletterFormAction`.
- Do not proxy via WordPress; submit directly to the original endpoint.

**Comments integrations** (`comments-*.php`):

- Hook `comments_template` filter to load a plugin-owned comments
  template that renders giscus / disqus / commento using the repo /
  shortname from detected context.
- Provide an options page override so the site owner can change the
  repo / shortname without editing code.
- Always defer loading JS to `wp_footer` with `defer` attribute.

**Analytics** (`analytics-*.php`):

- Each loader checks if its ID is set in options.
- GA4 uses the gtag.js snippet; GTM uses `GTM-XXXX` snippet; Plausible
  uses the official `plausible.io/js/plausible.js` snippet; Umami uses
  the `script` + `data-website-id` snippet.
- Do not load analytics if a cookie-consent flag is false (check
  `{{PLUGIN_SLUG_UNDERSCORED}}_cookie_consent()`).
- Never load on admin screens or for logged-in editors.

**Cookie banner** (`cookie-banner.php`):

- Renders at `wp_footer` priority 1.
- Stores consent in a first-party cookie `{{PLUGIN_SLUG_UNDERSCORED}}_consent`
  for 365 days.
- Provides `{{PLUGIN_SLUG_UNDERSCORED}}_cookie_consent()` helper.
- Accessible: role="dialog", aria-label, Escape key dismisses the banner.

**Dark mode** (`dark-mode.php`):

- Enqueues a 20-line JS that toggles `data-theme="dark"` on `<html>`.
- Persists to `localStorage` and syncs with `prefers-color-scheme`.
- Exposes `do_action('{{THEME_SLUG}}/dark_mode_toggle')` for the theme.

**Redirects** (`redirects.php`):

- Reads `WORDPRESS_MIGRATION/redirects.json` at plugin load if the file
  exists. Missing file must not emit warnings.
- On `template_redirect`, if the current request path matches a key, send
  a 301 to the mapped value.
- Skip redirects for logged-in admins.

**Social meta** (`social-meta.php`):

- Emits `og:title`, `og:description`, `og:image`, `og:type`,
  `twitter:card`, `twitter:site`, `twitter:creator` on `wp_head`
  priority 1, only on singular views.

**Open Graph image** must come from post meta `featured_image` or the
featured image attachment. Never a generic placeholder.

**Shortcodes** (`shortcodes.php`):

Port each `_source_includes/shortcodes/*.html` to
`add_shortcode('{{PLUGIN_SLUG_UNDERSCORED}}_<name>', …)`. Maintain the
exact attribute names the source used.

Additionally, the normalize phase rewrote every Liquid `{% include %}` in
post/page content into a WordPress shortcode. Register a handler for every
entry below so no raw shortcode text leaks to the rendered page — an
unregistered shortcode renders as `[wpify_xyz …]` in the post which is
strictly worse than the original Liquid output. The required names are:

```json
{{SHORTCODES_JSON}}
```

{{SHORTCODES_LIST}}

For each `wpify_<name>` shortcode:

1. Find the source template at `_includes/**/<name>.html` (try both
   `framework/shortcodes/<name>.html` and `shortcodes/<name>.html`). Port
   its Liquid markup to PHP — respect every attribute the source read.
2. If the source template does not exist, generate a reasonable default:
   render a `<div class="wpify-shortcode wpify-shortcode--<name>">` that
   dumps attribute key/value pairs as `data-*` attributes, so nothing is
   visually missing. Comment the file noting "synthetic — please edit".
3. Register on `init` so shortcodes resolve before `the_content` runs.
4. Every shortcode callback must `esc_*` every attribute it echoes.

The goal: a post containing `[wpify_figure src="/x.webp" caption="hi"]`
must render a real `<figure>` with that image, not the literal bracket
text.

**Blocks** (`blocks.php` + `blocks/<name>/`):

Register custom blocks with `register_block_type_from_metadata`. Each
block lives in its own folder with `block.json`, `render.php`,
`edit.js`, `view.js`, `style.css`. Do not use `@wordpress/create-block`
scaffolding that requires a build step unless the source already has one.

**Options page** (`options.php`):

- Adds a menu at `Settings → {{SITE_TITLE}}` (slug
  `{{PLUGIN_SLUG_UNDERSCORED}}_settings`).
- Uses the Settings API (`register_setting`, `add_settings_section`,
  `add_settings_field`).
- Seeds defaults from detected context (so fresh installs work without
  hand configuration).
- Fields: analytics IDs, newsletter endpoint, giscus/disqus/commento
  keys, cookie banner text, social handles.
- All options are prefixed `{{PLUGIN_SLUG_UNDERSCORED}}_`.

### Code-quality rules

1. Prefix every function, class, constant, hook, option name, post meta
   key, and block name with `wpify_` (neutral helpers) or
   `{{PLUGIN_SLUG_UNDERSCORED}}_` (plugin-specific).
2. Use namespaces only if the source is PHP ≥ 8; otherwise plain
   prefixed function names are fine.
3. Every file starts with `<?php` on line 1 and `if ( ! defined(
   'ABSPATH' ) ) { exit; }` right after the file docblock.
4. Escape outputs: `esc_html`, `esc_attr`, `esc_url`,
   `wp_kses_post`. Never echo unescaped user data.
5. Sanitize inputs: `sanitize_text_field`, `sanitize_email`,
   `esc_url_raw`, `wp_unslash` before DB writes.
6. Nonces on every form and AJAX action
   (`wp_create_nonce`, `check_admin_referer`).
7. Translation-ready: every user-visible string uses the plugin text
   domain `{{PLUGIN_SLUG}}`.
8. No composer, no build step, no npm unless registering a block forces
   it. Pure PHP + tiny inline JS where needed.
9. No external HTTP requests from PHP except to the analytics/newsletter
   endpoints that are already in detected context.

## Anti-patterns (banned)

- Function names without a prefix (e.g. `register_my_cpt()`).
- Storing config as constants instead of options.
- Hard-coding IDs, domains, tracking keys.
- Stub files that only `echo 'TODO';`.
- Duplicating functionality that belongs in the theme (header markup,
  body classes, layout templates).

## Self-check (walk every item before you stop)

- [ ] `{{PLUGIN_SLUG}}.php` contains only the header + `require_once`
      loop.
- [ ] Every detected feature in the matrix above has a non-stub include
      file, or is genuinely empty in the detected input.
- [ ] Every CPT in `choices.customPostTypes` is registered with the
      correct `rewrite` slug and `supports` array.
- [ ] Options page is reachable at `Settings → {{SITE_TITLE}}` and lists
      every editable key.
- [ ] No function, hook, option, or post meta key is unprefixed.
- [ ] `redirects.php` handles a missing `redirects.json` silently.
- [ ] No placeholder strings, no unfinished features.
- [ ] Text domain `{{PLUGIN_SLUG}}` is used consistently.
- [ ] `uninstall.php` removes plugin-created options; does NOT delete
      posts, pages, or media (those belong to the site).
