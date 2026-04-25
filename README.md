<div align="center">

<img src="./assets/logo.png" alt="to-wordpress" width="720" />

**Convert static sites, exports, and document folders into a local WordPress migration.**

[![npm](https://img.shields.io/npm/v/to-wordpress.svg?logo=npm&labelColor=222)](https://www.npmjs.com/package/to-wordpress)
[![downloads](https://img.shields.io/npm/dm/to-wordpress.svg?labelColor=222)](https://www.npmjs.com/package/to-wordpress)
[![license](https://img.shields.io/npm/l/to-wordpress.svg?labelColor=222)](./LICENSE)
[![node](https://img.shields.io/node/v/to-wordpress.svg?logo=node.js&logoColor=white&labelColor=222)](https://nodejs.org)

</div>

---

`to-wordpress` is an AI-assisted migration CLI with one aim: **one
command to migrate a site into WordPress**.

It uses the expert WordPress guidance from
[`WordPress/agent-skills`](https://github.com/WordPress/agent-skills/)
under the hood, but wraps it in fully automated migration recipes:
detect the source, plan the move, generate the theme/plugin, import the
content, verify the result, fix what failed, and leave a tune-up plan if
you want more polish.

Point it at a Jekyll, Hugo, Astro, WXR, Medium, Substack, Markdown,
DOCX, XLSX, PDF, EPUB, README, or plain text source and it builds a local
WordPress site with:

- a classic PHP theme,
- a site plugin,
- imported posts/pages/media,
- preserved URLs where possible,
- shortcode ports for reusable source snippets,
- verification and endpoint checks,
- and a post-run tuning loop for final polish.

It runs WordPress locally with [`@wordpress/env`](https://developer.wordpress.org/block-editor/getting-started/devenv/get-started-with-wp-env/)
and uses one of three agent CLIs for the creative parts:

- `claude` (default),
- `copilot`,
- `codex`.

## Install

```bash
npx to-wordpress ./my-site
```

Or install globally:

```bash
npm install -g to-wordpress
to-wordpress ./my-site
```

## Requirements

- Node.js 20+
- Docker
- One agent CLI:
  - Claude Code: `claude`
  - GitHub Copilot CLI: `copilot`
  - OpenAI Codex CLI: `codex`

The host machine does not need PHP, Ruby, or wp-cli installed.

## Usage

```bash
# default agent: Claude Code
npx to-wordpress ./my-jekyll-site

# use GitHub Copilot CLI
npx to-wordpress ./my-site --agent copilot

# use Codex
npx to-wordpress ./my-site --agent codex

# run without an agent, using deterministic fallbacks where available
npx to-wordpress ./my-site --skip-copilot
```

The result is written inside the source folder:

```text
WORDPRESS_MIGRATION.md
WORDPRESS_MIGRATION/
  theme/                generated classic theme
  plugin/               generated site plugin
  content/              normalized post/page markdown
  media/                copied media assets
  rendered/             source prerender reference
  import-manifest.json
  redirects.json
  verify-report.json
  test-fix-report.json
  tune-tasks.md         optional post-run repair plan
```

Open the migrated site at:

```text
http://localhost:8888
```

## Agents

Choose an agent with `--agent` or `TOWP_AGENT`.

| Agent | Flag | Default model |
|---|---|---|
| Claude Code | `--agent claude` | `claude-opus-4-7`, effort `high` |
| GitHub Copilot CLI | `--agent copilot` | `claude-opus-4.7`, effort `high` |
| OpenAI Codex CLI | `--agent codex` | `gpt-5.5-codex`, effort `high` |

Environment overrides:

```bash
CLAUDE_MODEL=claude-opus-4-7 CLAUDE_EFFORT=high npx to-wordpress .
COPILOT_MODEL=claude-opus-4.7 COPILOT_EFFORT=high npx to-wordpress . --agent copilot
CODEX_MODEL=gpt-5.5-codex CODEX_EFFORT=high npx to-wordpress . --agent codex
```

## What it does

The migration pipeline is:

1. **Detect** the source type and content structure.
2. **Plan** the migration using CLI parameters and detected defaults.
3. **Boot** a local WordPress with `wp-env`.
4. **Theme** the site as a classic PHP WordPress theme.
5. **Normalize** posts/pages/media into a canonical migration format.
6. **Plugin** site-specific behavior: CPTs, taxonomies, shortcodes,
   comments, analytics, redirects, options, and custom endpoints.
7. **Import** content and media with `wp eval-file`.
8. **Verify** post counts, pages, menu URLs, homepage links, titles, and
   HTML error markers.
9. **Testfix** important endpoints and retry fixes when needed.
10. **Tune the Press** after success: type remaining issues, get a repair
    plan, press `Y` to let the agent apply it.

Most phases run through an `attempt → test → fix` loop. If a phase fails,
the selected agent gets the error and recent logs, then attempts a
surgical repair.

## Supported sources

- Jekyll
- Hugo
- Eleventy
- Astro
- Gatsby
- Next.js
- Hexo
- Docusaurus
- MkDocs
- WordPress WXR
- Ghost JSON
- Medium exports
- Substack exports
- Markdown folders
- HTML folders
- DOCX / RTF folders
- XLSX / CSV / TSV files
- PDF folders
- EPUB books
- README / GitHub repository docs
- Plain text folders

Jekyll `_plugins/*.rb` files are read and passed to the plugin phase so
custom generators and endpoints, such as `/llm/...` pages or category
generators, can be recreated in WordPress.

## CLI

```text
Usage: to-wordpress [options] [source]

Options:
  --agent <claude|copilot|codex>
  --fresh
  --branch <name>
  --no-git
  --skip-boot
  --skip-copilot
  -y, --yes
  --only <phase>
  --from <phase>
  --until <phase>
  --max-attempts <n>
  --max-fix-passes <n>
  --fail-strategy <continue|skip|abort>

Plan options:
  --permalinks <keep|default>
  --cpts <all|none>
  --no-redirects
  --front-page <slug>
  --blog-index <slug>
  --privacy-page <slug>
  --admin-user <name>
  --admin-password <pass>
  --admin-email <email>
```

Examples:

```bash
# run only through normalization
npx to-wordpress ./site --until normalize

# rerun from theme with an existing wp-env
npx to-wordpress ./site --from theme --skip-boot

# CI-style non-interactive run
npx to-wordpress ./site -y --fail-strategy abort
```

## Development

```bash
git clone https://github.com/f/to-wordpress
cd to-wordpress
npm install
npm run typecheck
npm test
npm run build
```

Live agent smoke test:

```bash
npx tsx test/agents-live.test.ts
```

Project layout:

```text
src/agents/     agent adapters: claude, copilot, codex
src/detectors/  source detectors
src/phases/     migration phases and retry loop
src/prompts/    agent prompts
src/tui/        Ink UI
src/wp/         wp-env / wp-cli helpers
```

## Contributing

Issues and PRs are welcome.

This project is currently tested in real-world use primarily against
**Jekyll** sites. The other detectors and conversion paths are implemented,
but they need more real migrations, fixtures, and verification feedback.

Useful contributions:

- new detectors,
- fixtures and test sites for non-Jekyll sources,
- stronger verification rules,
- better prompts for specific frameworks,
- new agent adapters,
- real-world migration bug reports.

## License

MIT © Fatih Kadir Akın
