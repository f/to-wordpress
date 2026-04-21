{{SHARED}}

## Phase: Normalize (convert HTML page → markdown)

You're receiving a single HTML file (possibly a scraped article or a
hand-written page). Produce one canonical markdown file with YAML
front matter.

## Scope

- Write allowed: `{{TARGET_FILE}}` and new files under `{{MEDIA_DIR}}`.
- Read allowed: `{{SOURCE_FILE}}`.

## Inputs

- Source HTML: `{{SOURCE_FILE}}`
- Target markdown: `{{TARGET_FILE}}`
- Media dir: `{{MEDIA_DIR}}`
- Default post type: `{{POST_TYPE}}`
- Detector briefing: {{DETECTOR_BRIEFING}}

## Extraction rules

- Title ← first of: `<meta property="og:title">`, `<title>`, first
  `<h1>`.
- Date ← first of: `<meta property="article:published_time">`,
  `<time datetime>`, `<meta name="date">`, filename prefix, today.
- Excerpt ← first of: `<meta name="description">`,
  `<meta property="og:description">`, first paragraph truncated
  to 220 chars.
- Author ← `<meta name="author">` or `rel="author"` anchor text.
- Featured image ← `<meta property="og:image">`.

Discard: `<nav>`, `<header>`, `<footer>`, `<aside>`, ads, subscription
prompts, "related articles" rails. Keep the semantic `<article>` /
`<main>` body.

## Body conversion

- Use `pandoc -f html -t gfm --extract-media={{MEDIA_DIR}}` if
  available.
- Otherwise parse the DOM and emit markdown directly. Preserve:
  headings, lists, blockquotes, code blocks (with language hint from
  `class="language-*"`), inline formatting, links, images, tables,
  and `<iframe>` embeds as raw HTML (Gutenberg embeds).
- Remove inline `style=""` attributes.

## Front matter

```yaml
title: string
slug: kebab-case
date: ISO-8601
status: publish | draft
post_type: {{POST_TYPE}}
excerpt: string
author: string
featured_image: media:<flat-name> or null
source_path: {{SOURCE_FILE}}
```

## Self-check

- [ ] No leftover `<script>`, `<style>`, or tracking pixels in the body.
- [ ] No relative paths to deleted scrape artifacts — rewrite or drop.
- [ ] Every `<img>` became either a `![](media:...)` reference (asset
      copied) or a remote URL kept verbatim.
