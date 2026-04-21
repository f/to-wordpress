{{SHARED}}

## Phase: Normalize (convert EPUB → markdown files)

You're receiving one EPUB ebook. Emit **one markdown file per chapter**
under `{{TARGET_DIR}}/<post_type>/`, plus (optionally) a front-matter
only "book overview" page whose body lists the chapters.

## Scope

- Write allowed: `{{TARGET_DIR}}` + `{{MEDIA_DIR}}`.
- Read allowed: `{{SOURCE_FILE}}`.

## Inputs

- Source EPUB: `{{SOURCE_FILE}}`
- Target dir: `{{TARGET_DIR}}`
- Media dir: `{{MEDIA_DIR}}`
- Default post type: `{{POST_TYPE}}`
- Detector briefing: {{DETECTOR_BRIEFING}}

## How to read

EPUB is a ZIP. Try in order:

1. `pandoc -f epub -t gfm "{{SOURCE_FILE}}" -o /tmp/<slug>.md` (single
   file), then split on `^##\s` headings into chapters.
2. `unzip -p "{{SOURCE_FILE}}" OEBPS/content.opf` to read metadata;
   `unzip "{{SOURCE_FILE}}" -d /tmp/<book>` to access spine HTML.
3. `calibre ebook-convert` if installed.

## Metadata (book-level)

From the OPF package:

- `<dc:title>` → book title (used as site title if not yet set).
- `<dc:creator>` → author (default author for all chapter posts).
- `<dc:date>` → publish date.
- `<item id="cover" media-type="image/*">` → featured image for
  chapter 1.

## Per-chapter front matter

```yaml
title: <chapter heading>
slug: kebab-case
date: <book date or today>
status: publish
post_type: {{POST_TYPE}}
author: <book author>
chapter: <1-based index>
book: <book title>
source_path: {{SOURCE_FILE}}
```

Chapter slug = `chapter-<NN>-<slug-of-title>` (zero-padded to 2
digits) so chapters sort naturally.

## Body conversion rules

- Spine HTML → markdown. Retain inline formatting, lists, tables,
  blockquotes.
- Preserve internal cross-references by slug (`see [Chapter 3](/chapter/chapter-03-title/)`).
- Images and SVGs copy to `{{MEDIA_DIR}}` and become
  `![](media:<flat>)`.
- Drop publisher navigation links ("Next chapter", "Table of contents").

## Self-check

- [ ] One markdown file per chapter exists.
- [ ] Chapter ordering is preserved via the `chapter:` field and slug
      prefix.
- [ ] Every `media:` image exists in `{{MEDIA_DIR}}`.
- [ ] No empty chapter bodies.
