{{SHARED}}

## Phase: Theme refinement (pass {{PASS}} of {{MAX_PASSES}})

The Theme phase just produced a first draft. The theme is activated
on the live WordPress at `{{WP_URL}}` but **the home page does not
yet match the source**. Your job is surgical: close the visual gap
between the two pages below. Nothing else.

## Scope

- Write allowed: only inside `{{THEME_DIR}}`. No plugin changes, no
  content changes, no wp-env changes, no DB writes.
- Read allowed: anything under `{{THEME_DIR}}`, `{{SOURCE_DIR}}`, and
  the rendered reference dir.
- Shell allowed: `curl`/`fetch` to `{{WP_URL}}` only, and
  `npx @wordpress/env run cli -- wp …` for read-only wp-cli
  (`option get`, `theme list`, `plugin list`). No `wp option update`,
  no `wp post …`, no wp-cli writes.

## Inputs

### Gap report (authoritative — fix every item)

```json
{{GAP_REPORT_JSON}}
```

### Source rendered reference (ground truth)

Source-site home page as built by the source SSG. This is what the
WordPress home MUST look like structurally:

```html
{{SOURCE_HOME_HTML}}
```

### Live WordPress home

What WordPress is rendering right now at `{{WP_URL}}`:

```html
{{LIVE_HOME_HTML}}
```

### Directories

- Theme: `{{THEME_DIR}}`
- Mirrored source layouts: `{{THEME_DIR}}/_source_layouts/`
- Mirrored includes: `{{THEME_DIR}}/_source_includes/`
- Mirrored data: `{{THEME_DIR}}/_data_source/`
- Compiled stylesheet: `{{THEME_DIR}}/style.css`
- Prerendered reference root: `{{RENDERED_DIR}}`

## How to diagnose

1. Read `{{GAP_REPORT_JSON}}` top-to-bottom. Each issue names:
   - `kind` (missing-heading, wrong-heading, missing-nav-item,
     wrong-nav-text, missing-image, extra-image, class-drift,
     wrong-menu-count, wrong-footer-copy, empty-body, other).
   - `selector` — CSS selector pointing at the broken element, when
     we could compute one.
   - `expected` / `actual` — strings from the two pages.
2. For each issue, locate the template/part responsible:
   - Hero → `front-page.php` + `template-parts/**/title.php` /
     `hero.php`.
   - Header nav → `header.php` +
     `template-parts/**/header.php` + `inc/data.php` menu getter.
   - Footer → `footer.php` + `template-parts/**/footer.php`.
   - Cards / post listing → `home.php` + `template-parts/**/card.php`.
3. Open the matching `_source_layouts/` or `_source_includes/` file
   and the rendered sample. Copy the exact DOM and class list.
4. Edit the PHP template so its output matches the reference's
   structure and text content for dynamic data
   (`bloginfo('name')`, `get_the_title()`, etc.).

## Non-negotiable rules

1. **Do not silence the diff.** Removing a missing element from
   the theme or from the reference does not count as a fix.
2. **Titles keep their HTML.** Always `wp_kses_post( get_the_title() )`
   in templates, never `esc_html`.
3. **External links pass through `esc_url` verbatim** —
   never prefix with `home_url()` or `./`.
4. **Assets are `get_template_directory_uri() . '/assets/…'`** — no
   absolute URLs to the source domain, no broken `src=""`.
5. **Text domain** on every `__()`, `_e()` call is `{{THEME_SLUG}}`.
6. **Keep changes minimal.** If a single class name is off, change
   that one class. Don't rewrite the whole template.
7. **Compile, don't hardcode.** If a color or font appears wrong,
   fix it in `_sass_source/` and recompile `style.css`, not by
   slapping an inline `<style>` tag in `header.php`.

## Quick actions

- To re-fetch live HTML yourself: `curl -s {{WP_URL}} | head -400`.
- To compare two snippets:
  `diff <(curl -s {{WP_URL}}) {{RENDERED_DIR}}/index.html | head -200`.
- To check which template WP picked for the home page:
  `npx @wordpress/env run cli -- wp option get template` and
  `… get stylesheet`; make sure both are `{{THEME_SLUG}}`.
- To recompile Sass if `sass` binary is installed:
  `sass --no-source-map --style=compressed {{THEME_DIR}}/_sass_source/style.scss {{THEME_DIR}}/style.css`.

## Self-check (walk every item before you stop)

- [ ] Every issue in `{{GAP_REPORT_JSON}}` has a matching code change.
- [ ] No file was written outside `{{THEME_DIR}}`.
- [ ] The hero `<h1>` (or its equivalent) text now matches the
      reference character-for-character (HTML tags included).
- [ ] Every nav item in the source header has a matching entry in
      the rendered WP header (either via `wp_nav_menu` or the
      `inc/data.php` fallback).
- [ ] No new placeholder / TODO / lorem text crept in.
- [ ] You did not call `wp option update`, `wp theme install`, or any
      other DB-mutating wp-cli command.
