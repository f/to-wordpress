{{SHARED}}

## Phase: Normalize (README → WordPress landing page)

You're receiving the top-level `README.md` (or another top-level
document: `LICENSE`, `CHANGELOG`, `CONTRIBUTING`, `CODE_OF_CONDUCT`)
from a GitHub-style code repository. The goal is NOT a plain blog
post — it's a proper product/landing WordPress **page**.

## Scope

- Write allowed: `{{TARGET_FILE}}` and `{{MEDIA_DIR}}`.
- Read allowed: anywhere under `{{SOURCE_DIR}}` — you may quote
  examples from source files to enrich the page.

## Inputs

- Source file: `{{SOURCE_FILE}}`
- Target markdown: `{{TARGET_FILE}}`
- Media dir: `{{MEDIA_DIR}}`
- Source repo root: `{{SOURCE_DIR}}`
- Hint: `{{HINT}}`   (one of: "landing", "license", "changelog",
  "contributing", "code-of-conduct")
- Detector briefing: {{DETECTOR_BRIEFING}}

## Page structures by hint

### hint = "landing"

The README is the front door. Compose a landing page with these
sections in Gutenberg block format:

1. **Hero** — project name, tagline, primary CTA button (link to the
   first install command in the README or to the repo's GitHub URL if
   present in `package.json` or `.git/config`).
2. **Badges strip** — every shields.io badge in the README becomes a
   small tag in a horizontal group.
3. **Feature grid** — pull the top-level bullet list that typically
   follows the hero. Render as a 3-column Gutenberg columns block;
   each bullet becomes one column with a heading (first bold phrase
   of the bullet) + explanatory sentence.
4. **Install / Quickstart** — first fenced code block labelled `bash`,
   `sh`, `zsh`, or `console` becomes a highlighted install card.
5. **Usage example** — the next fenced code block (any language)
   becomes a Gutenberg code block with syntax highlight.
6. **FAQ / Details** — every H2 that follows is mapped to a Gutenberg
   details block (collapsed by default) for a clean page.
7. **Footer CTA** — "Get started" button pointing at install.

Slug = `home` (unless a stronger candidate exists). In front matter
set `role: front` so the import phase can make this the site's front
page.

### hint = "license"

Slug = `license`; title = "License"; role = `none`; body = the
license text rendered as a quote/preformatted block. Add a short
intro sentence explaining which license applies.

### hint = "changelog"

Slug = `changelog`; body preserves the reverse-chronological list
of releases. Each `## [x.y.z] - YYYY-MM-DD` becomes a H2 with a
divider above.

### hint = "contributing" / "code-of-conduct"

Straight conversion of the markdown to a page; slug and title taken
from the filename.

## Front matter (always required)

```yaml
title: string
slug: kebab-case
date: ISO-8601 (today)
status: publish
post_type: page
role: front | none        # only "front" for landing
excerpt: tagline (first sentence after title for landing; first
         paragraph otherwise)
source_path: {{SOURCE_FILE}}
```

## Rules

1. **No TODO / Lorem ipsum / placeholder sentences.** If a section
   wouldn't have real content, don't emit it.
2. **Images** from the README (and referenced SVGs in `docs/`,
   `assets/`, etc.) → download into `{{MEDIA_DIR}}` and reference as
   `media:<flat>`.
3. **External links** (docs.repo.com, GitHub URLs, mailto:) → keep
   absolute verbatim.
4. **Code fences** keep language hints — `bash`, `js`, `ts`, etc.
5. **Tagline detection**: the first italic / emphasized line under
   the H1, OR the first non-heading paragraph under the H1. Use this
   as the page's `excerpt`.

## Self-check

- [ ] File starts with `---` and has `post_type: page`.
- [ ] For `hint=landing`, body begins with a hero h1 and at least one
      CTA link.
- [ ] No duplicate H1 inside the body (the front-matter `title` is
      the H1).
- [ ] Every `media:` image was copied into `{{MEDIA_DIR}}`.
- [ ] No "placeholder", "TODO", "Lorem ipsum" strings anywhere.
