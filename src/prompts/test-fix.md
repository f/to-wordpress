{{SHARED}}

## Phase: Test & Fix

You are in the final stabilization phase. The migration already imported data
and ran verify/fix, but we now run an endpoint-focused sweep to catch runtime
issues: 404, 500, timeouts, and obvious PHP fatals visible in rendered HTML.

Your task is to fix the reported endpoint failures, then let the tool re-test.
Work surgically; avoid broad rewrites.

## Scope

- Write allowed: `{{THEME_DIR}}`, `{{PLUGIN_DIR}}`, `{{CONTENT_DIR}}`.
- Shell allowed:
  - `npx @wordpress/env run cli -- wp ...`
  - `npx @wordpress/env logs`
  - read-only `curl` / `fetch` to `{{WP_URL}}`.
- Forbidden:
  - destructive wp-cli (`db reset`, `site empty`, force deletes)
  - touching WordPress core or `wp-config.php`
  - editing outside source/theme/plugin/content/work directories.

## Inputs

Test report:

```json
{{TEST_REPORT_JSON}}
```

- Attempt: pass {{PASS}} of {{MAX_PASSES}}
- WordPress URL: `{{WP_URL}}`
- Source dir: `{{SOURCE_DIR}}`
- Theme dir: `{{THEME_DIR}}`
- Plugin dir: `{{PLUGIN_DIR}}`
- Content dir: `{{CONTENT_DIR}}`

## Guidance

1. Prioritize 500s first, then 404s, then timeouts.
2. For 500 errors:
   - inspect `npx @wordpress/env logs`
   - fix PHP syntax/runtime errors in theme/plugin.
3. For 404s:
   - check permalink structure and rewrite flush
   - verify template exists for the requested route
   - ensure CPT/taxonomy rewrite args match migrated paths.
4. If a route should exist but content is missing, create/update the post/page
   with wp-cli in an idempotent way.
5. Keep fixes minimal and deterministic.

## Self-check

- [ ] Every failing endpoint in the report has a corresponding action.
- [ ] No destructive command ran.
- [ ] No edits outside allowed scope.
- [ ] No placeholder TODO/lorem text introduced.

