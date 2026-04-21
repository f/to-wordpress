{{SHARED}}

## Phase: Normalize (convert WordPress WXR → markdown files)

The source is a WordPress eXtended RSS export (`.xml`). Split it into
one markdown file per `<item>` under
`{{TARGET_DIR}}/<post_type>/<slug>.md`.

## Scope

- Write allowed: `{{TARGET_DIR}}` + `{{MEDIA_DIR}}`.
- Read allowed: `{{SOURCE_FILE}}`.

## Inputs

- Source WXR: `{{SOURCE_FILE}}`
- Target dir: `{{TARGET_DIR}}`
- Media dir: `{{MEDIA_DIR}}`
- Default post type: `{{POST_TYPE}}`
- Detector briefing: {{DETECTOR_BRIEFING}}

## Parsing

Use `python3 -c "import xml.etree..."`, `xmlstarlet`, or any streaming
XML parser. Register the WP namespaces:

- `wp = "http://wordpress.org/export/1.2/"`
- `content = "http://purl.org/rss/1.0/modules/content/"`
- `excerpt = "http://wordpress.org/export/1.2/excerpt/"`
- `dc = "http://purl.org/dc/elements/1.1/"`

## Item → markdown mapping

```
<title>              → title
<wp:post_name>       → slug (fallback: kebab-case title)
<wp:post_date_gmt>   → date (ISO-8601)
<wp:status>          → status (publish|draft|private|pending)
<wp:post_type>       → post_type (post, page, attachment, or CPT)
<dc:creator>         → author
<content:encoded>    → body (HTML, preserve Gutenberg comments)
<excerpt:encoded>    → excerpt
<category domain="category">       → categories
<category domain="post_tag">       → tags
<wp:postmeta>        → meta_<key> in front matter (skip keys starting
                       with `_`, except `_thumbnail_id`)
```

For `<item wp:post_type="attachment">`: download `<wp:attachment_url>`
into `{{MEDIA_DIR}}` with a deterministic flat name. These are NOT
emitted as posts — they populate `{{MEDIA_DIR}}` so the import phase
can sideload them.

## Body conversion

- Keep `<!-- wp:* -->` block comments intact — they're already
  Gutenberg.
- Preserve all HTML inside `<content:encoded>` — the import phase
  wants real HTML, not markdown-escaped HTML.
- Rewrite attachment URLs: if the URL points to a file now in
  `{{MEDIA_DIR}}`, change it to `media:<flat-name>`.

## Front matter (per item)

```yaml
title: string
slug: kebab-case
date: ISO-8601
status: publish | draft | private | pending
post_type: string
author: string
categories: [string]
tags: [string]
excerpt: string
featured_image: media:<flat> or null
post_id: <int, from wp:post_id>
source_path: {{SOURCE_FILE}}
```

## Rules

1. **Never skip items** — even empty drafts must produce a markdown
   file so the editorial history survives.
2. **Never reorder** — file creation order should mirror the XML
   order.
3. **Handle duplicates**: if two items share the same slug + post_type,
   suffix the second with `-2`, `-3`…
4. Strip `<!--more-->` comments from the body but use them to set
   `excerpt` if the front matter doesn't already have one.

## Self-check

- [ ] Count of emitted markdown files == count of `<item>` elements
      minus attachment items.
- [ ] Every attachment URL is present in `{{MEDIA_DIR}}` (or skipped
      with a logged warning).
- [ ] Categories/tags arrays are deduped per item.
- [ ] No `<item>` metadata fields were lost (compare `_meta_keys`).
