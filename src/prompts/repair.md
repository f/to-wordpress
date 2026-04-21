{{SHARED}}

## Phase: Repair (auto-invoked on phase failure)

The `{{PHASE}}` phase of `to-wordpress` just failed. The CLI is about
to retry it — your job is to diagnose the failure and make the
smallest change that lets the retry succeed. This is **not** the
Verify→Fix loop (that runs against a live WordPress comparing it to
the source). This is surgical: one phase, one failure, fix it.

## Scope

- Write allowed: `{{THEME_DIR}}`, `{{PLUGIN_DIR}}`, `{{CONTENT_DIR}}`,
  `{{WORK_DIR}}`.
- Read allowed: anything under `{{SOURCE_DIR}}`, `{{WORK_DIR}}`, and
  the directories above.
- Shell allowed: `npx wp-env ...`, `npx @wordpress/env ...`, `docker …`,
  `wp-cli` via `npx wp-env run cli -- wp ...`. Run from `{{SOURCE_DIR}}`.
- Forbidden: editing WordPress core, editing `wp-config.php`,
  destructive wp-cli (`db reset`, `site empty`, `post delete --force`,
  `plugin delete`, `theme delete`), rewriting the user's source tree.

## Inputs

- Failed phase: **`{{PHASE}}`** — {{PHASE_TITLE}}
- Attempt number: {{ATTEMPT}}
- Error message:

```
{{ERROR_MESSAGE}}
```

- Recent log tail (most recent ≤120 lines written by this phase):

```
{{RECENT_LOGS}}
```

- Detected source kind: `{{SOURCE_KIND}}`
- Detector briefing: {{DETECTOR_BRIEFING}}
- Key directories:
  - Source: `{{SOURCE_DIR}}`
  - Theme: `{{THEME_DIR}}`
  - Plugin: `{{PLUGIN_DIR}}`
  - Normalized content: `{{CONTENT_DIR}}`
  - Migration workdir: `{{WORK_DIR}}` (holds `import-manifest.json`,
    `import.php`, `detected.json`, `shortcodes.json`, `converted/…`)
  - wp-env config: `{{WP_ENV_CONFIG}}`
  - wp-env WordPress URL: `{{WP_URL}}`

## Per-phase diagnostic checklists

Match `{{PHASE}}` to the block below. If the error message clearly
fits one of these patterns, start there. Otherwise walk the generic
checklist at the bottom.

### `detect`

- Was the source directory empty? List it; if so, nothing to migrate.
- Did a detector throw? Check which one from the log tail. If a
  specific file parse failed (e.g. malformed YAML), fix the parse
  guard, not the user's file.

### `plan`

- Did Copilot fail to write `WORDPRESS_MIGRATION.md`? Make sure the
  file exists and has the `<!-- WPIFY:STATE:START --> { … } <!-- END -->`
  JSON block. Rewrite only the missing section.

### `boot`

- "wp-env start failed": run
  `npx @wordpress/env logs` (or `docker ps` + `docker logs …`) to get
  the real error. Likely: Docker not running, port 8888 already in
  use, mapping pointing to a non-existent dir, or PHP fatal at boot
  from the stub plugin. Fix cause; don't swallow it.
- Check `{{WP_ENV_CONFIG}}` — its `mappings` must include an entry
  for `wp-content/to-wordpress` → the migration workdir path, and
  that path must exist.

### `theme` / `plugin`

- Copilot likely didn't leave `style.css` / `index.php` /
  `<slug>.php` at the required spots. Verify they exist and have
  valid PHP. If a fatal syntax error, open the file and fix the
  specific parse error — do NOT rewrite from scratch.

### `normalize`

- A conversion prompt failed on a specific source file. The log
  usually names the file. Check that the required external tool
  exists in `PATH` (`pandoc`, `pdftotext`, `python3`). If not, fall
  back to the deterministic path documented in the convert prompt,
  or write a draft stub for that single item so the phase can
  continue.

### `import`

- "`wp-content/to-wordpress/import.php` does not exist": the wp-env
  mapping isn't live in the container. Confirm `{{WP_ENV_CONFIG}}`'s
  `mappings["wp-content/to-wordpress"]` points at `{{WORK_DIR}}` and
  that `{{WORK_DIR}}/import.php` exists on host. Then run
  `npx @wordpress/env start --update` to re-apply mappings without a
  full rebuild. Verify in-container with
  `npx @wordpress/env run cli -- ls wp-content/to-wordpress/`.
- "PHP Fatal error" while importing item `<slug>`: open
  `{{WORK_DIR}}/import.php` around the reported line; the `wpify_try`
  wrapper already catches most throws — add the missing guard if a
  new edge case leaked through.
- CPT not registered: ensure the plugin is active
  (`wp plugin list --status=active`). If not, activate it. If the
  plugin's `register_post_type` uses `init` with too-late priority,
  lower it to `5`.
- wp-cli "command not found" inside the container: the `cli`
  service isn't started. `npx @wordpress/env start`.

### `verify` / `fix`

- Verify's `fetch` times out: ensure `{{WP_URL}}` responds.
  `npx @wordpress/env run cli -- wp option get siteurl` — if
  mismatched, update it with `wp option update siteurl` and
  `home`.

## Generic checklist (when the phase-specific block didn't match)

1. **Read the actual tool output**, not just the one-line error. Run
   the failing command in a shell and capture full stderr. For
   wp-env: `npx @wordpress/env run cli -- wp …`. For Docker:
   `docker ps`, `docker logs`.
2. **Identify the root cause**. Is it a missing file? Permissions?
   Missing dependency? Syntax error in generated code? Out-of-date
   wp-env mapping?
3. **Make the smallest possible fix** in the allowed scope. Never
   silently work around the issue by skipping it.
4. **Prove the fix**. Before you stop, re-run the failing sub-step
   (e.g. `npx @wordpress/env run cli -- wp eval-file …`) and confirm
   a non-zero exit has become zero. If the full phase is too
   expensive to re-run, test the smallest reproducer.

## Rules

1. **No silent skips.** Do not delete failing input to make a phase
   pass. Do not stub out a failing block so the retry "succeeds"
   without doing the real work.
2. **No lorem / TODO / placeholder** strings.
3. **Do not modify `WORDPRESS_MIGRATION.md`.** The CLI owns that
   file.
4. **Do not modify `.wp-env.json` unless the root cause is a wrong
   mapping or port.** If you do modify it, also run
   `npx @wordpress/env start --update` so the change is applied.
5. **Do not run `wp-env destroy` or `wp-env clean`.** The user's
   in-progress state would be lost.
6. **Do not commit changes** — the outer CLI handles git commits.

## Self-check (walk every item before you stop)

- [ ] I understand what failed and why.
- [ ] I made the minimum viable edit to fix the cause.
- [ ] I verified the fix by re-running the failing sub-step, or by
      reading the now-fixed code and confirming the error branch can
      no longer be reached.
- [ ] I touched no file outside the Scope list.
- [ ] I did not paper over a real error.
- [ ] I did not commit.
