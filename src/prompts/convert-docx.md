{{SHARED}}

## Phase: Normalize (convert Word document → markdown)

You're receiving a single Microsoft Word document (`.docx`, `.doc`, or
`.rtf`). Convert it into one canonical markdown file the import phase
can ingest. The output MUST be valid UTF-8 markdown with a YAML front
matter header.

## Scope

- Write allowed: **only** `{{TARGET_FILE}}` (and new files under
  `{{MEDIA_DIR}}` if the document contains embedded images).
- Read allowed: `{{SOURCE_FILE}}`.
- No other side effects.

## Inputs

- Source document: `{{SOURCE_FILE}}`
- Target markdown path: `{{TARGET_FILE}}`
- Media output dir: `{{MEDIA_DIR}}`
- Default post type: `{{POST_TYPE}}`
- Detector briefing: {{DETECTOR_BRIEFING}}

## How to read the file

Try in this order and stop at the first one that works:

1. `pandoc -f docx -t gfm --extract-media={{MEDIA_DIR}} "{{SOURCE_FILE}}"`
2. `unzip -p "{{SOURCE_FILE}}" word/document.xml` and parse the OOXML
   paragraphs / runs / images yourself.
3. If none of the above produce readable output, shell to any other
   converter you know (`mammoth`, `soffice --headless --convert-to md`,
   `textutil` on macOS for `.rtf`).

If every path fails, write a placeholder-free fallback: emit a post
whose body is the single sentence `This document could not be
converted automatically; please edit to add body.` and set status =
`draft`.

## Required output

`{{TARGET_FILE}}` must begin with a YAML front-matter block with these
keys (omit a key only if you genuinely cannot determine it):

```yaml
title: string           # first H1, or "Title" document property, or filename
slug: string            # kebab-cased title
date: ISO-8601          # "Created" / "Modified" metadata if present, else today
status: publish|draft   # draft if the doc has "DRAFT" in header/footer
post_type: {{POST_TYPE}}
excerpt: string         # first paragraph, ≤ 240 chars, no newlines
author: string          # document "Author" property, if set
categories: [string]    # [] if unknown
tags: [string]          # [] if unknown
featured_image: media:<flat-name>.jpg   # only if there's a clear cover image
source_path: {{SOURCE_FILE}}
```

followed by the body in GitHub-flavored markdown:

- Map Word heading levels 1..6 to `#`..`######`.
- Map lists, tables, blockquotes, bold/italic, inline code, code
  blocks (no language hint) faithfully.
- Images → `![](media:<flat-name>)`. Each embedded image MUST be copied
  to `{{MEDIA_DIR}}` using a deterministic flat name (e.g.
  `source-basename__image1.png`).
- Hyperlinks → `[text](url)`.
- Footnotes → `[^n]` references with definitions at the bottom.

## Rules

1. **No HTML tags** in the body unless absolutely necessary (e.g. to
   preserve a table layout pandoc can't express).
2. **No Lorem ipsum, TODO, placeholder bodies.** If extraction fails
   partially, keep whatever real content came through and stop.
3. **Titles keep their inline formatting** (`*em*`, `**strong**`,
   `` `code` ``) — Word runs often include these.
4. Strip revision marks, comments, and tracked changes — export only
   the current visible text.
5. Strip page numbers, running headers, and footer boilerplate like
   "Page 1 of 7" or company watermarks.

## Self-check

- [ ] `{{TARGET_FILE}}` exists and starts with `---`.
- [ ] Front matter contains `title`, `slug`, `date`, `status`,
      `post_type`, `source_path`.
- [ ] Body is non-empty or status is `draft`.
- [ ] Every `![](media:...)` reference points to a file that now
      exists in `{{MEDIA_DIR}}`.
- [ ] No tracked-change markup, no MS-Word XML tags, no
      `http://schemas.openxmlformats.org/...`.
