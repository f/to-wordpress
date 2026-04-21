{{SHARED}}

## Phase: Normalize (convert PDF → markdown)

You're receiving one PDF file. Produce a single markdown file with
YAML front matter.

## Scope

- Write allowed: `{{TARGET_FILE}}` and images extracted into
  `{{MEDIA_DIR}}`.
- Read allowed: `{{SOURCE_FILE}}`.

## Inputs

- Source PDF: `{{SOURCE_FILE}}`
- Target markdown: `{{TARGET_FILE}}`
- Media dir: `{{MEDIA_DIR}}`
- Default post type: `{{POST_TYPE}}`
- Detector briefing: {{DETECTOR_BRIEFING}}

## How to read the file

Try in this order, stopping at the first success:

1. `pdftotext -layout "{{SOURCE_FILE}}" -` (Poppler)
2. `pandoc "{{SOURCE_FILE}}" -t gfm`
3. `python3 -m pdfminer.high_level {{SOURCE_FILE}}`

For images:

1. `pdfimages -all -p "{{SOURCE_FILE}}" {{MEDIA_DIR}}/<basename>__`
2. If that's unavailable, skip — a text-only conversion is acceptable.

## Rebuilding structure from extracted text

Raw `pdftotext` output loses heading hierarchy. Rebuild it with these
heuristics, in order:

1. A line in ALL CAPS or preceded by a blank line and larger than the
   surrounding body text → `##` heading.
2. "Chapter N" / "Section N" → `##` heading.
3. Numbered lists (`1. `, `2. `) survive as markdown ordered lists.
4. Tables: if columns line up across ≥ 3 consecutive lines using
   whitespace, convert to a GFM pipe table.
5. Preserve paragraph breaks (blank lines).
6. Strip recurring headers / footers (same line appearing on ≥ 3
   pages).
7. Strip hyphenation at line wraps (`some-\nthing` → `something`).
8. Strip page-number lines (`- 12 -`, `Page 12 of 50`).

## Front matter

```yaml
title: string          # PDF metadata "Title" property, else first big heading
slug: kebab-case
date: ISO-8601         # /CreationDate if present, else today
status: publish
post_type: {{POST_TYPE}}
excerpt: first 220 chars of body
author: PDF "Author" property, if present
source_path: {{SOURCE_FILE}}
pages: <int>
```

## Rules

1. **Never dump raw PDF streams** or `%%EOF` markers into the output.
2. **No Lorem ipsum / placeholders** — if extraction is empty, write
   a one-line "Imported from PDF, please add body" and set status
   `draft`.
3. Image references: `![](media:<flat-name>)`.
4. Keep the visible text order — do NOT reorder sections even if the
   PDF was mis-ordered.

## Self-check

- [ ] Target file starts with `---`.
- [ ] Body has real prose (≥ 1 paragraph) or status is `draft`.
- [ ] No raw `\n`, `\f`, or form-feed artifacts in the body.
- [ ] Any `![](media:...)` reference points to an existing file.
