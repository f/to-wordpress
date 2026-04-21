{{SHARED}}

## Phase: Normalize (convert CSV → markdown files)

This is a CSV/TSV variant of the xlsx conversion prompt. Read the file
directly (no binary decoder needed), then follow the same field
mapping / per-row output rules as `convert-xlsx.md`.

## Scope

- Write allowed: any file under `{{TARGET_DIR}}`.
- Read allowed: `{{SOURCE_FILE}}`.

## Inputs

- Source file: `{{SOURCE_FILE}}`
- Target directory: `{{TARGET_DIR}}`
- Default post type: `{{POST_TYPE}}`
- Detector briefing: {{DETECTOR_BRIEFING}}

## Rules

1. Detect delimiter from the first line (`,`, `\t`, `;`, `|`).
2. If the file has a BOM, strip it.
3. Quoted fields may contain embedded newlines — use a real CSV parser,
   not a line-by-line split.
4. Follow the column-mapping table in `convert-xlsx.md`.

## Self-check

- [ ] Every non-empty title row produced a markdown file.
- [ ] Every markdown file is non-empty.
- [ ] No raw CSV escape artifacts (`""`, trailing commas) leaked into
      the body.
