{{SHARED}}

## Phase: Fix

Verify produced a report of mismatches between the source site and the
live WordPress at `{{WP_URL}}`. Close every issue with the smallest
possible change. You have at most a few iterations before the tool gives
up and surfaces the remaining issues to the user — prioritize.

## Scope

- Write allowed inside: `{{THEME_DIR}}`, `{{PLUGIN_DIR}}`, `{{CONTENT_DIR}}`.
- Shell allowed: `npx wp-env run cli wp …` for DB-level fixes
  (permalinks, term assignments, post status, menu items, options). Run
  shell from the source directory (`{{SOURCE_DIR}}`).
- Forbidden: editing WordPress core, editing files outside the scopes
  above, running destructive wp-cli commands (`db reset`,
  `plugin delete`, `theme delete`, `site empty`, `post delete` on posts
  not marked missing in the report), re-importing the whole manifest.

## Inputs

Live Verify report (this is the source of truth):

```json
{{VERIFY_REPORT_JSON}}
```

- Working WordPress URL: `{{WP_URL}}`
- Theme directory: `{{THEME_DIR}}`
- Plugin directory: `{{PLUGIN_DIR}}`
- Normalized content root: `{{CONTENT_DIR}}`
- wp-env working dir (for wp-cli): `{{SOURCE_DIR}}`

## Triage order (process issues in this order)

1. **`count_mismatch`** on a post type → the easiest and biggest win.
   Inspect `{{CONTENT_DIR}}/<type>/*.md` vs the live count. Likely
   causes: posts still in `draft`, slug collisions that re-imported as
   update, or WP auto-created posts blocking slugs. Fixes (in order):
   a. `wp post list --post_type=<t> --post_status=any` to see what's
      there.
   b. Flip any `draft` that should be `publish`:
      `wp post update <id> --post_status=publish`. Only flip posts that
      exist in the normalized content with `status: publish`.
   c. If a normalized file has no matching WP post, create it via
      `wp post create --post_type=<t> --post_title="…" --post_name=<slug>
      --post_status=publish --post_date=… <<< "$content"`.
   d. Never delete user content to balance a count.
2. **`http_error` 404 on permalink** → usually a rewrite issue.
   a. Re-check `wp option get permalink_structure`; if missing, set it
      to match the plan's chosen structure.
   b. `wp rewrite flush --hard`.
   c. For CPTs, ensure the plugin's `register_post_type` uses
      `rewrite => ['slug' => '…', 'with_front' => false]` and that the
      plugin is active.
3. **`http_error` 404 on a page** like `/` → the front page is not
   configured. Verify `show_on_front = page` and
   `page_on_front = <id of home page>`. Fix if wrong.
4. **`title_mismatch`** → either the theme is stripping HTML from the
   title (replace `esc_html(get_the_title())` with
   `wp_kses_post( get_the_title() )` in the specific template), or the
   post's `post_title` was imported stripped — update the post's
   `post_title` from the corresponding `{{CONTENT_DIR}}` file.
5. **`http_error` 500** → read `wp-env logs` or inspect the PHP file
   the last theme/plugin change touched. Fix syntax errors or missing
   functions. Never silence an error with `@`.
6. **Missing hero / missing image on a page** (listed as an issue with
   `kind=other` or `title_mismatch` on `/`) → check
   `front-page.php` + `header.php` in the theme against the rendered
   reference in `{{CONTENT_DIR}}/../rendered/index.html`.

## Rules

1. **One issue per commit-sized change.** Make the smallest edit that
   closes the specific issue in the report.
2. **Prefer code fixes over data fixes** for structural problems
   (missing template, missing hook, stripped title rendering).
3. **Prefer data fixes over code fixes** for per-post problems (one
   draft that should be publish, one missing term).
4. **Idempotent wp-cli.** Re-running your commands must not produce
   duplicates or errors.
5. **No re-import loops.** Do not re-run the full
   `wp eval-file import.php` manifest. If you must re-import a single
   post, do it with `wp post create` or `wp post update`.
6. **No data loss.** Do not delete media, posts, or terms that were
   imported from the source. Do not overwrite user-edited content.
7. **Keep timestamps.** Preserve `post_date`, `post_modified` from the
   source when updating.

## Anti-patterns (banned)

- Modifying `wp-config.php`, WordPress core, or the wp-env Docker config.
- Running `wp db reset`, `wp post delete --force`, `wp site empty`.
- Suppressing PHP errors with `@`, `error_reporting(0)`, or
  `ini_set('display_errors','0')`.
- "Fixes" that only rewrite the Verify report to look empty.
- Rewriting an entire PHP file from scratch when a 3-line change would
  work.

## Workflow

1. Read the report. Bucket issues by `kind`.
2. For each bucket, decide the minimal surgical fix. Write the code or
   run the wp-cli command.
3. When every issue has an applied fix, stop. The tool re-runs Verify
   and either advances or calls you again with a reduced report.

## Self-check (walk every item before you stop)

- [ ] Every issue in the report has a matching action you took.
- [ ] No file was touched outside the Scope directories.
- [ ] No shell command was destructive.
- [ ] You did not re-import the full manifest.
- [ ] You did not silence a PHP error.
- [ ] You did not touch `wp-config.php` or core.
