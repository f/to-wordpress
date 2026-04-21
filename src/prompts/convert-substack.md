{{SHARED}}

## Phase: Normalize (convert Substack export → markdown files)

You're receiving a Substack export. The export always contains:

- `posts.csv` — one row per post (id,post_date,is_published,type,title,
  subtitle,audience,email_sent_at,podcast_url,…)
- `posts/<post_id>.html` — one HTML body per post.

Produce one markdown file per row under
`{{TARGET_DIR}}/<post_type>/<slug>.md`.

## Scope

- Write allowed: `{{TARGET_DIR}}` + `{{MEDIA_DIR}}`.
- Read allowed: the whole substack export folder (so you can join
  CSV rows with HTML files).

## Inputs

- Source file: `{{SOURCE_FILE}}` (the CSV, or one HTML file; when
  you see an HTML file, its corresponding CSV is one dir up at
  `posts.csv`)
- Target dir: `{{TARGET_DIR}}`
- Media dir: `{{MEDIA_DIR}}`
- Hint: `{{HINT}}`   ("manifest" or "body")

## Join logic

If you're handed `posts.csv` ("manifest"), iterate every row and
locate its matching `posts/<id>.html`. Emit one markdown file per
row. If you're handed a single `.html` ("body"), do the row-lookup
only for that one id.

## Column mapping

- `post_id` → slug prefix (`post-<id>`) if no slug derivable from title.
- `post_date` → date (ISO-8601).
- `is_published` → `publish` if true, `draft` otherwise.
- `type`: `newsletter` → post, `podcast` → podcast CPT, `thread` →
  post with `format: thread` meta.
- `title` → title.
- `subtitle` → excerpt.
- `audience` = `only_paid` → status `private`; `only_free` or
  `everyone` → status `publish`.
- `podcast_url` → if present, attach as audio embed at the top of
  the body (Gutenberg audio block).

## Body rules

- Strip Substack footers: "Thanks for reading…", "Subscribe", "Leave
  a comment", "Share" buttons, paid-wall teasers.
- Rewrite `substackcdn.com` images to local `media:<flat>` (download).
- Convert `<blockquote class="captioned-image">` to Gutenberg image
  blocks.
- Keep `<iframe>` embeds verbatim (Gutenberg embed handles them).

## Front matter

```yaml
title: string
slug: kebab-case
date: ISO-8601
status: publish | draft | private
post_type: post | podcast
excerpt: string
author: string           # Substack CSV doesn't always include author,
                         # derive from the publication config if needed
tags: []
featured_image: media:<flat> or null
source_path: <path to HTML file>
substack_post_id: <int>
```

## Self-check

- [ ] Every published CSV row produced a markdown file with matching
      body.
- [ ] Every `only_paid` row became status `private`.
- [ ] No raw Substack "Subscribe" or "Share" blocks survive.
- [ ] Podcast audio (if any) is present as a Gutenberg `core/audio`
      block at the top of its post's body.
