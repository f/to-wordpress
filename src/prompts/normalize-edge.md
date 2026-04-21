{{SHARED}}

## Phase: Normalize (edge case)

A deterministic pass has already normalized most source posts. This file
failed the deterministic normalizer because its front-matter or body has
constructs the tool did not recognize. Your job is to produce one clean
canonical markdown file that the Import phase can ingest without further
transformation.

## Scope

- Write allowed: **only** `{{TARGET_FILE}}` (and create its parent
  directories if missing).
- Read allowed: anything under the source directory.
- Do not modify the original source file. Do not touch any other
  normalized file.

## Inputs

- Source file: `{{SOURCE_FILE}}`
- Target file: `{{TARGET_FILE}}`
- Post type: `{{POST_TYPE}}` (if unknown, default to `post`)

## Canonical schema

Front-matter MUST match this schema exactly. Keys not in the schema must
be dropped.

```yaml
title: string                  # required; HTML (<em>, <strong>, <code>, <br>, <a>) allowed
slug: string                   # required; URL-safe lowercase-kebab
date: string                   # required; ISO-8601 UTC (e.g. 2024-05-12T08:30:00.000Z)
updated: string                # optional; same format as date
author: string                 # optional; login-safe (lowercase, no spaces)
status: publish | draft        # default publish; use draft iff source says `published: false`
excerpt: string                # optional
categories: [string]           # optional
tags: [string]                 # optional
featured_image: string         # optional; path relative to source root (e.g. /assets/images/x.png)
post_type: string              # default {{POST_TYPE}}
original_permalink: string     # required; the URL the source served this at
source_path: string            # required; absolute path of the source file
```

## Rules

1. **Do not invent values.** If the source has no title, derive it from
   the slug with Title Case — do not fabricate words. If the source has
   no date, use the filename's leading `YYYY-MM-DD`; if none, fall back
   to the file's mtime.
2. **Preserve HTML in the title.** Do not `<strong>` a word that was
   plain, and do not strip HTML the source uses.
3. **Body cleanup.**
   - Replace each `{% include <path> %}` that refers to a known shortcode
     partial with a WordPress shortcode call like
     `[wpify_button text="…"]` using the same attributes.
   - Unknown `{% include X %}` MUST become
     `<!-- wpify:include src="X" reason="unresolved" -->` so the fix
     phase can see it.
   - Remove Liquid loops that iterate over site collections — those are
     layout concerns, not content. If removing one leaves an empty
     section, remove the section wrapper too.
   - Leave fenced code blocks, inline code, images, internal links,
     blockquotes, and tables verbatim.
4. **Relative image paths.** Rewrite body `<img src="...">` and
   `![alt](path)` so paths start with `/assets/…` (absolute from site
   root). Do NOT replace them with `media:<flat>` markers — that is the
   deterministic normalizer's job for new files, and the import runner
   will resolve the references at import time.
5. **Categories / tags.** Always arrays, even when there is one. Empty
   arrays are allowed.
6. **Permalink.** If the source declared `permalink:` in front-matter,
   use it verbatim. Otherwise compute from the collection's default
   permalink template using the slug.
7. **Slug.** Must match `^[a-z0-9]+(-[a-z0-9]+)*$`. Collapse underscores
   to hyphens. Preserve the existing slug unless it violates this
   pattern.

## Output format

Write `{{TARGET_FILE}}` as a standard markdown file with YAML front-matter:

```markdown
---
title: …
slug: …
…
---

<body content here, cleaned>
```

Newline after the closing `---`, trailing newline at end of file.

## Anti-patterns (banned)

- Adding new metadata fields that weren't in the source.
- Dropping the title's HTML tags.
- Rewriting a heading hierarchy to start from H2 instead of H1.
- Replacing real content with a summary or placeholder.
- Turning draft posts into publish or vice-versa.

## Self-check (walk every item before you stop)

- [ ] `{{TARGET_FILE}}` exists and has the canonical front-matter
      schema; no extra keys.
- [ ] Title preserves any HTML tags present in the source.
- [ ] Date parses as ISO-8601 UTC.
- [ ] `slug` matches `^[a-z0-9]+(-[a-z0-9]+)*$`.
- [ ] No `{% … %}` or `{{ … }}` Liquid tags remain in the body.
- [ ] Any unresolved include is marked with
      `<!-- wpify:include src="…" reason="…" -->`.
- [ ] `original_permalink` and `source_path` are set.
- [ ] No other file on disk was modified.
