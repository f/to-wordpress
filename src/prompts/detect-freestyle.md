{{SHARED}}

## Phase: Detect (freestyle fallback)

The built-in detectors (jekyll, hugo, eleventy, gatsby, next, ghost,
plain-html) did not recognize the source confidently. Your job is to walk
the source yourself and produce a usable `DetectedContext` JSON so the
rest of the pipeline can still migrate it. We never skip a folder —
we always try to migrate.

## Scope

- Write allowed: **only** `{{OUTPUT_PATH}}`.
- Read allowed: anything under `{{SOURCE_DIR}}`.
- No other side effects.

## Inputs

- Source directory: `{{SOURCE_DIR}}`
- Seed inventory from the deterministic pre-scan:

```json
{{SEED_JSON}}
```

The seed already walked the tree with build/vendor dirs filtered. Use it
as a map; read specific files on demand to fill in the blanks.

## Required output schema

Write one JSON file at `{{OUTPUT_PATH}}` with exactly these keys (use
`null` or `[]` for unknowns — never omit a key):

```json
{
  "kind": "jekyll | hugo | eleventy | gatsby | next | hexo | astro | docusaurus | mkdocs | ghost-export | wp-wxr | medium-export | substack-export | plain-html | markdown-folder | docx-folder | xlsx-sheet | pdf-folder | text-folder | epub-book | github-repo | unknown",
  "siteTitle": "string or null",
  "domain": "https://… or null",
  "themeSlug": "lowercase-kebab-case",
  "pluginSlug": "themeSlug + '-site'",
  "layouts": ["absolute paths"],
  "includes": ["absolute paths"],
  "sassFiles": ["absolute paths"],
  "assetsDirs": ["absolute paths to folders whose contents become theme assets"],
  "dataFiles": ["absolute paths to structured data: yml / json / toml"],
  "ssgPlugins": ["absolute paths to SSG plugin / hook files"],
  "collections": [
    { "name": "string", "dir": "absolute path", "permalink": "/…/:slug/", "count": <int> }
  ],
  "pages": ["absolute paths to standalone page source files"],
  "frontMatterKeys": ["keys observed across front-matter"],
  "features": {
    "newsletterFormAction": "string or null",
    "giscusRepo": "string or null",
    "disqusShortname": "string or null",
    "googleAnalyticsId": "string or null",
    "gtmId": "string or null",
    "plausibleDomain": "string or null",
    "umamiWebsiteId": "string or null",
    "cookieBanner": <bool>,
    "darkMode": <bool>,
    "metaOpengraphType": "string or null",
    "twitterSite": "string or null",
    "twitterCreator": "string or null"
  },
  "colors": { "primary_bg": "#…", "base_bg": "#…", "base_text": "#…" } ,
  "fonts": { "heading": "string", "base": "string", "monospace": "string" }
}
```

## Rules

1. **Never skip a folder.** Every directory under the source is in play.
   If a folder contains content (markdown, HTML templates, data files,
   assets), classify it — don't ignore it.
2. **Never return an empty context.** If the site has no obvious
   content, still emit:
   - `layouts`: every `.html|.njk|.liquid|.hbs|.ejs|.pug` file found.
   - `pages`: every `.md|.mdx` file found.
   - `assetsDirs`: every top-level folder that looks like assets (`assets`,
     `static`, `public`, `images`, `img`, `media`, `css`, `js`, `fonts`).
3. **Prefer collections over pages.** Any directory with ≥ 3 markdown
   files of a similar shape (same front-matter keys) is a collection.
   Infer the collection name from the parent folder (`articles/` →
   `articles`, `stories/culture/` → `culture`).
4. **Detect SSG when possible.** Reading `package.json`,
   `Gemfile`, `hugo.toml`, `gatsby-config.*`, or `eleventy.config.*`
   should let you set `kind` with confidence. If still ambiguous, keep
   `"unknown"` but still fill every other field.
5. **Paths absolute.** Every path in the output must begin with the
   source directory prefix.
6. **Front-matter keys.** Sample up to 30 content files to produce a
   deduped set of keys.
7. **Features.** Grep the source for analytics IDs (`G-[A-Z0-9]+`,
   `UA-\d+-\d+`, `GTM-[A-Z0-9]+`), newsletter form actions
   (`list-manage.com`, `mailchimp.com`, `convertkit`, `buttondown`),
   comments (`giscus`, `disqus`, `commento`), cookie consent widgets,
   dark-mode toggles. If present in ANY template, capture.
8. **Colors & fonts.** If a config or SCSS variable file (`_variables.scss`,
   `theme.config`, `tailwind.config`) declares brand colors or font
   families, capture them. Prefer the site's declared tokens over
   guessing.
9. **Do not invent content.** If a field is unknown, set it to `null` or
   `[]`.

## Anti-patterns (banned)

- Outputting only what the seed already knew (do at least one round of
  reading files to refine it).
- Emitting relative paths.
- Classifying a content-bearing directory as "skip".
- Inventing a collection that doesn't exist in the source.

## Self-check (walk every item before you stop)

- [ ] The output file exists at `{{OUTPUT_PATH}}`.
- [ ] Every schema key is present (use `null` / `[]` where unknown).
- [ ] `layouts` + `pages` collectively cover every
      content-bearing file you saw.
- [ ] Every content-bearing directory is represented either in
      `collections` or `pages`.
- [ ] Paths are absolute.
- [ ] If `kind == "unknown"`, the rest of the fields are still fully
      populated so downstream phases can proceed.
