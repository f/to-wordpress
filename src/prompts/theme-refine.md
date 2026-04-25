{{SHARED}}

## Phase: Theme refinement (pass {{PASS}} of {{MAX_PASSES}})

The Theme phase produced a classic PHP theme and the home page at
`{{WP_URL}}` does not yet match the source. Your job is surgical: close
the visual gap between the source-rendered page and the live WordPress
page. Nothing else.

## Scope

- Write allowed: only inside `{{THEME_DIR}}`.
- Read allowed: `{{THEME_DIR}}`, `{{SOURCE_DIR}}`, `{{RENDERED_DIR}}`.
- No plugin changes, no content changes, no DB writes.
- Shell allowed: read-only `curl` to `{{WP_URL}}`, and read-only wp-cli
  (`option get`, `theme list`, `plugin list`). No DB-mutating wp-cli.

## Inputs

### Gap report

```json
{{GAP_REPORT_JSON}}
```

### Source rendered reference

```html
{{SOURCE_HOME_HTML}}
```

### Live WordPress home

```html
{{LIVE_HOME_HTML}}
```

### Directories

- Theme: `{{THEME_DIR}}`
- Classic templates: `{{THEME_DIR}}/*.php`
- Template parts: `{{THEME_DIR}}/template-parts/**/*.php`
- Data helpers: `{{THEME_DIR}}/inc/data.php`
- Stylesheet: `{{THEME_DIR}}/style.css`
- Source layouts: `{{THEME_DIR}}/_source_layouts/`
- Source includes: `{{THEME_DIR}}/_source_includes/`
- Rendered reference root: `{{RENDERED_DIR}}`

## How to diagnose

1. Read the gap report top-to-bottom.
2. Locate the responsible classic template/part:
   - Hero → `front-page.php` or a `template-parts/**/hero.php` part.
   - Header/nav → `header.php` or `template-parts/**/header.php` plus
     `inc/data.php` fallback menu.
   - Footer → `footer.php` or `template-parts/**/footer.php`.
   - Cards/blog list → `home.php` and card template parts.
   - Single post → `single.php`.
3. Open the matching source layout/include and rendered sample.
4. Edit the smallest PHP/CSS file needed. Preserve source classes.

## Non-negotiable rules

1. Do not silence the diff by removing source UI.
2. This remains a classic theme. Do not create block theme folders or
   files: `templates/*.html`, `parts/*.html`, `patterns/*.php`, block
   `block.json`, `edit.js`, etc.
3. Titles keep HTML: `wp_kses_post( get_the_title() )`, never
   `esc_html( get_the_title() )`.
4. External links pass through `esc_url()` verbatim; do not wrap with
   `home_url()`.
5. Assets use `get_template_directory_uri() . '/assets/…'`.
6. Fix CSS in `style.css`; do not add inline `<style>` tags.
7. Keep changes minimal.

## Quick actions

- Fetch live HTML: `curl -s {{WP_URL}} | head -400`.
- Compare snippets: `diff <(curl -s {{WP_URL}}) {{RENDERED_DIR}}/index.html | head -200`.
- Recompile Sass if available:
  `sass --no-source-map --style=compressed {{THEME_DIR}}/_sass_source/style.scss {{THEME_DIR}}/style.css`.

## Self-check

- [ ] Every issue in `{{GAP_REPORT_JSON}}` has a matching code change.
- [ ] No file was written outside `{{THEME_DIR}}`.
- [ ] No block-theme files were created.
- [ ] Hero H1 matches reference character-for-character, HTML included.
- [ ] Every nav item in the source header is rendered in WordPress.
- [ ] No placeholder / TODO / lorem text.
- [ ] No DB-mutating wp-cli command was used.
