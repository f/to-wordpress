{{SHARED}}

## Phase: Plan

You are the Plan phase. A deterministic detector has inventoried the source
and the CLI has written a skeleton `WORDPRESS_MIGRATION.md`. Your job is to
edit that file in place and produce a concrete, actionable migration plan
that later phases can execute without guessing.

## Scope

- Edit allowed: **only** `{{PLAN_PATH}}`.
- Read allowed: anything under `{{SOURCE_DIR}}`.
- Do not create, modify, or delete any other file.

## Inputs

- Source directory: `{{SOURCE_DIR}}`
- SSG kind: `{{KIND}}`
- Detected context (JSON):

```json
{{DETECTED_JSON}}
```

- User choices (JSON):

```json
{{CHOICES_JSON}}
```

## Required output

Fill in every one of these headings **above** the
`<!-- WPIFY:STATE:START` marker, in this order, and keep the JSON state
block below the marker byte-for-byte untouched:

### 1. Overview

3–5 sentences describing: what the source is, what we are producing, which
features are in scope for the theme vs the plugin, and which URL shape we
will keep.

### 2. Template mapping

A complete markdown table with one row per source layout AND one row per
source include. Columns:

| source file | target WP file | notes |

Rules:

- Every file in `detected.layouts` + `detected.includes` must appear.
- Layouts map to top-level templates (`single.php`, `page.php`,
  `archive.php`, `home.php`, `front-page.php`, `single-<cpt>.php`,
  `taxonomy-<tax>.php`, `404.php`, `search.php`).
- Includes map to `template-parts/<group>/<name>.php` mirroring their
  source path (e.g. `_includes/framework/header.html` →
  `template-parts/framework/header.php`).
- If a layout has no WP equivalent, say so and explain the collapse (e.g.
  merging `blog-2.html` + `blog-3.html` variants into `home.php`).

### 3. Feature-to-output mapping

A complete markdown table with one row per detected feature:

| feature | owner | implementation |

`owner` is `theme` | `plugin` | `mainstream-plugin` | `skip-with-reason`.
`implementation` names the file (theme) or hook (plugin) or external
plugin slug (e.g. `wordpress-seo`). Every truthy value in
`detected.features` must appear; every custom collection in
`detected.collections` (other than `posts`) must appear as a CPT row; any
custom taxonomy hinted at by `detected.frontMatterKeys` (`categories`,
`tags`, custom ones) must appear.

### 4. URL mapping

State concretely:

- The WordPress `permalink_structure` string we will set.
- The rewrite rules each CPT needs (`rewrite => ['slug' => '…', 'with_front' => false]`).
- A list of 301 redirects (old path → new path) for any URL shape that is
  not preserved exactly. If `choices.createRedirects` is false, write "No
  redirects needed — permalinks preserved."

### 5. Risks & open questions

Bulleted list, max 10 items. Each item names the file or feature at risk
and the proposed mitigation. Do not include trivial items.

### 6. Acceptance criteria

A checklist the Verify phase will use. Bullet format, each one a
measurable fact (e.g. "Home page at `/` contains the H1 `Building with
<em>AI</em>, …`", "`/blog/` returns 200 and lists ≥ 12 posts", "Each
category page at `/category/<slug>/` returns 200").

## Rules

- Do not change anything between the `WPIFY:STATE:START` and
  `WPIFY:STATE:END` markers, including whitespace. The CLI reads that
  block back as JSON.
- Do not create a new file. Do not touch the theme, plugin, or content
  directories — those are owned by later phases.
- If the plan doc already has some of these sections populated from a
  previous run, rewrite them; do not append duplicates.

## Self-check (walk every item before you stop)

- [ ] Every source layout AND include has a row in the Template mapping.
- [ ] Every item in `detected.features` (truthy) has a row in the
      Feature-to-output mapping.
- [ ] Every custom collection has an `owner = plugin` CPT row.
- [ ] Permalink structure is one concrete string, not a choice.
- [ ] The state JSON block below the marker is byte-identical to what you
      read. Diff it mentally; if unsure, do not touch it.
- [ ] No placeholder text (`TBD`, `Lorem ipsum`, `…`, `<to be filled>`).
