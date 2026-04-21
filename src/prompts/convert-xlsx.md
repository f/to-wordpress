{{SHARED}}

## Phase: Normalize (convert spreadsheet → markdown files)

You're receiving a single spreadsheet (`.xlsx`, `.xlsm`, `.xls`, `.csv`,
or `.tsv`). Emit **one markdown file per row** under
`{{TARGET_DIR}}/{post-type}/{slug}.md`.

## Scope

- Write allowed: any file under `{{TARGET_DIR}}`.
- Read allowed: `{{SOURCE_FILE}}`.
- No other side effects.

## Inputs

- Source file: `{{SOURCE_FILE}}`
- Target directory: `{{TARGET_DIR}}`
- Default post type: `{{POST_TYPE}}`
- Detector briefing: {{DETECTOR_BRIEFING}}

## How to read the file

1. For `.csv` / `.tsv`: read the file directly; detect the delimiter
   from the first line.
2. For `.xlsx` / `.xlsm` / `.xls`: prefer `python3 -c "import openpyxl..."`,
   `ssconvert`, or `soffice --headless --convert-to csv` to dump each
   sheet to CSV, then proceed as above.

If the xlsx has multiple sheets, treat every non-empty sheet as its
own collection — file rows under `{{TARGET_DIR}}/<sheet-slug>/`.

## Column mapping

Map headers case-insensitively. Common aliases, in order of
preference:

- title → title, heading, headline, name, subject
- slug → slug, permalink (strip leading `/`), url (basename)
- date → date, published_at, created_at, publish_date
- status → status, state (map "published"→`publish`,
  "draft"→`draft`, "archived"→`private`)
- body → body, content, text, description, post_content, html
- excerpt → excerpt, summary, abstract, teaser
- author → author, by, writer
- categories → category, categories (comma-split)
- tags → tag, tags, keywords (comma-split)
- featured_image → image, cover, thumbnail, featured_image
- post_type → type, post_type (default `{{POST_TYPE}}`)

If a header doesn't fit any known field, expose it as
`meta_<sanitized_key>: <value>` in the front matter.

## Required output (per row)

`{{TARGET_DIR}}/<post_type>/<slug>.md` with this front matter:

```yaml
title: string
slug: kebab-case
date: ISO-8601
status: publish | draft | private
post_type: string
excerpt: string
categories: [string]
tags: [string]
featured_image: string | null
source_row: <sheet>:<1-based-row>
```

followed by the body.

- If the `body`/`content` column contains HTML, preserve Gutenberg
  blocks it already has; otherwise convert to markdown.
- If the row has no body, synthesize a short body from the excerpt or
  a single paragraph restating the title — never emit an empty post.

## Rules

1. **Skip rows where the title is empty** — treat them as spacer rows.
2. **Slug collisions**: append `-2`, `-3`, … to the second, third
   occurrence of the same slug.
3. **Dates** that don't parse as ISO-8601 must fall back to "today"
   and be logged via the `source_row` field so a human can fix later.
4. **Never reorder columns** — preserve row order as part of the
   chronological sequence.

## Self-check

- [ ] At least one markdown file written for every non-empty title row.
- [ ] Every file starts with `---`.
- [ ] Slugs are unique within the target directory.
- [ ] No file has a blank body.
