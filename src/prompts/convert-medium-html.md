{{SHARED}}

## Phase: Normalize (convert Medium export HTML → markdown)

You're receiving a single HTML file out of a Medium export ZIP
(`posts/<date>_<slug>-<hash>.html` or `posts/draft_<slug>-<hash>.html`).
Convert it to one canonical markdown file.

## Scope

- Write allowed: `{{TARGET_FILE}}` and `{{MEDIA_DIR}}`.
- Read allowed: `{{SOURCE_FILE}}`.

## Inputs

- Source HTML: `{{SOURCE_FILE}}`
- Target markdown: `{{TARGET_FILE}}`
- Media dir: `{{MEDIA_DIR}}`
- Default post type: `{{POST_TYPE}}`
- Hint: `{{HINT}}`   (either "publish" or "draft")

## Medium quirks to know

- Title is `<h1 class="p-name">`.
- Subtitle (use as excerpt) is `<section data-field="subtitle">`.
- Body is inside `<section data-field="body">`.
- Author is `<a class="p-author" rel="author">`.
- Date is `<time class="dt-published" datetime="...">`.
- Images come as `<figure>` with `<img data-image-id="..." data-width="..." data-height="...">`.
  Captions are `<figcaption>`. Convert each figure into a Gutenberg
  image block with caption.
- Embedded code: `<pre data-code-block-mode="..."><code>...</code></pre>`
  (no language hint — use a safe default like ``` ``` ```).
- Gists: `<a href="https://gist.github.com/..."` anchor sitting alone
  in its paragraph → emit a Gutenberg gist embed.
- Tweets: `<blockquote class="twitter-tweet">` → Gutenberg twitter
  embed using the quoted-tweet URL.
- Drop: Medium's "This post was originally published…" and
  "Sign up for…" footer sections, clap count blocks, follow CTAs.

## Front matter

```yaml
title: string
slug: extracted from filename (strip leading `draft_`, leading
      `YYYY-MM-DD_`, and trailing `-<hash>`)
date: from <time datetime="...">
status: {{HINT}}        # publish or draft
post_type: {{POST_TYPE}}
author: string
excerpt: string
tags: [string]          # from footer tags block if present
featured_image: media:<flat> or null
source_path: {{SOURCE_FILE}}
canonical_url: string   # the `<link rel="canonical">` Medium embeds
```

## Rules

1. Set `canonical_url` so we can later add a rel=canonical in
   WordPress — Medium SEO parity.
2. Strip Medium's tracking pixels / redirect URLs. If a link's URL is
   `https://medium.com/r/?url=...`, unwrap to the real URL.
3. Media: every `<img>` is downloaded into `{{MEDIA_DIR}}` with a
   deterministic flat name (`<post-slug>__image<n>.<ext>`) and
   referenced as `media:<flat>`.

## Self-check

- [ ] Front matter has `title`, `slug`, `date`, `status`, `author`,
      `canonical_url`.
- [ ] Body has no leftover "Sign up…" / "Share on Twitter" CTAs.
- [ ] Every image was downloaded or kept as a remote URL
      deliberately.
