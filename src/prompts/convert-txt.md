{{SHARED}}

## Phase: Normalize (convert plain text / RST → markdown)

You're receiving a single `.txt` (or `.rst`) file. Produce one
canonical markdown file.

## Scope

- Write allowed: `{{TARGET_FILE}}`.
- Read allowed: `{{SOURCE_FILE}}`.

## Inputs

- Source file: `{{SOURCE_FILE}}`
- Target markdown: `{{TARGET_FILE}}`
- Default post type: `{{POST_TYPE}}`
- Detector briefing: {{DETECTOR_BRIEFING}}

## Body rules

- Title = first non-empty line (stripped of leading `=`/`#`/`*`).
- Body = the rest, with:
  - Blank-line-separated paragraphs preserved.
  - Auto-link bare URLs as `<https://…>`.
  - Underline headings (`=====`, `-----`) converted to `##`/`###`.
  - RST directives (`.. note::`, `.. image::`) converted to
    Gutenberg group blocks or image blocks as applicable.
  - `>` → blockquote.
  - Tabs → 4 spaces (safe default for code).
- Date: if the filename matches `YYYY-MM-DD*`, use that date;
  otherwise use today.

## Front matter

```yaml
title: string
slug: kebab-case(filename)
date: ISO-8601
status: publish
post_type: {{POST_TYPE}}
source_path: {{SOURCE_FILE}}
```

## Rules

1. **Never drop content** — a plain-text file should produce a post
   with the same visible text.
2. **No HTML tags** in the body.
3. If the file is entirely empty, write a single-line placeholder
   body and set status `draft`.

## Self-check

- [ ] File starts with `---`.
- [ ] Body is non-empty.
- [ ] No trailing whitespace on lines.
