{{SHARED}}

## Phase: Blockify

Convert every reusable part the normalize phase found into a proper
**Gutenberg block** targeting **WordPress 6.9+** (apiVersion 3). Each
block replaces a legacy `[towp_<name>]` shortcode with a native
block users can edit visually in the block editor.

Follow the official Block Editor Handbook conventions:
- Block metadata: https://developer.wordpress.org/block-editor/reference-guides/block-api/block-metadata/
- Dynamic rendering: https://developer.wordpress.org/block-editor/reference-guides/block-api/block-registration/
- apiVersion 3 (iframe editor): https://developer.wordpress.org/block-editor/reference-guides/block-api/block-api-versions/

---

## Scope

- Write allowed: only inside `{{BLOCKS_DIR}}` (one subdirectory per block).
- Read allowed: anything under `{{SOURCE_DIR}}`, the plugin dir, and
  `{{CONTENT_DIR}}` (for reference).
- Do NOT touch the theme, other plugin files, or wp-env.

## Inputs

Shortcodes to convert (one block per name):

```json
{{SHORTCODES_JSON}}
```

Source Liquid templates (port their logic into `render.php`):

{{SOURCE_TEMPLATES}}

---

## Required output per block

For every shortcode `<name>` above, create `{{BLOCKS_DIR}}/<name>/` with
these files. Every file MUST be non-empty and correctly formed.

### `block.json` — metadata (apiVersion 3 required)

```json
{
  "$schema": "https://schemas.wp.org/trunk/block.json",
  "apiVersion": 3,
  "name": "{{PLUGIN_SLUG}}/<name>",
  "version": "1.0.0",
  "title": "<Humanized Name>",
  "category": "widgets",
  "icon": "<dashicon-slug>",
  "description": "<one-line description>",
  "keywords": ["<name>", "migrated"],
  "textdomain": "{{PLUGIN_SLUG}}",
  "supports": {
    "html": false,
    "align": ["wide", "full"],
    "anchor": true,
    "spacing": { "margin": true, "padding": true }
  },
  "attributes": {
    "src":     { "type": "string", "default": "" },
    "alt":     { "type": "string", "default": "" },
    "caption": { "type": "string", "default": "" }
  },
  "render": "file:./render.php",
  "editorScript": "file:./edit.js",
  "style": "file:./style.css",
  "editorStyle": "file:./editor.css"
}
```

**Rules**:

- `"apiVersion": 3` is mandatory (WP 6.9+ iframe editor).
- Always include `"$schema"` for editor validation tooling.
- `"name"` MUST match `{{PLUGIN_SLUG}}/<name>` exactly. Changing it later
  breaks every saved block instance.
- `attributes` MUST include every variable the source template reads
  (every `{{ include.X }}` in the Liquid source → one attribute with
  correct `type`).
- Use `"render": "file:./render.php"` for server-side rendering —
  this makes the block a dynamic block (save() returns null).
- Include `supports.align` only for media-ish blocks; skip it for
  inline/text blocks.

### `render.php` — frontend rendering (authoritative)

This is what the frontend serves. Port the source Liquid logic faithfully.

```php
<?php
/**
 * Render for {{PLUGIN_SLUG}}/<name>.
 *
 * @var array    $attributes Block attributes from block.json.
 * @var string   $content    Inner content (for blocks with inner blocks).
 * @var WP_Block $block      Block instance.
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

$attrs = wp_parse_args( (array) ( $attributes ?? [] ), [
    'src'     => '',
    'alt'     => '',
    'caption' => '',
] );

$wrapper = get_block_wrapper_attributes( [
    'class' => 'towp-block towp-block-<name>',
] );

if ( empty( $attrs['src'] ) ) {
    return ''; // Or a sensible fallback.
}
?>
<figure <?php echo $wrapper; ?>>
    <img src="<?php echo esc_url( $attrs['src'] ); ?>" alt="<?php echo esc_attr( $attrs['alt'] ); ?>" />
    <?php if ( ! empty( $attrs['caption'] ) ) : ?>
        <figcaption class="wp-element-caption"><?php echo esc_html( $attrs['caption'] ); ?></figcaption>
    <?php endif; ?>
</figure>
```

**Rules** (every one is mandatory):

- **`get_block_wrapper_attributes()`** on the outer element. Never
  hard-code `class` without merging through this function — it's how
  WordPress attaches block support styles (spacing, anchor, align).
- **Escape every output**: `esc_url()`, `esc_attr()`, `esc_html()`,
  `wp_kses_post()`. Never echo an attribute directly.
- **Match source DOM exactly**: same tags, same class names, same text
  structure as the Liquid template. Verify compares rendered output.
- **Guard file**: start with `if ( ! defined( 'ABSPATH' ) ) { exit; }`.
- **No HTTP requests** from render.php — must be fast.

### `edit.js` — editor experience (no-build inline form)

For a zero-build plugin, use the classic `wp.blocks.registerBlockType`
API with `wp.element.createElement`. This works without webpack /
@wordpress/scripts:

```js
/* global wp */
( function () {
    const { registerBlockType } = wp.blocks;
    const { useBlockProps, InspectorControls } = wp.blockEditor;
    const { PanelBody, TextControl, TextareaControl } = wp.components;
    const { __ } = wp.i18n;
    const { createElement: el, Fragment } = wp.element;

    registerBlockType( '{{PLUGIN_SLUG}}/<name>', {
        edit: function ( props ) {
            const { attributes, setAttributes } = props;
            const blockProps = useBlockProps();

            return el( Fragment, {},
                el( InspectorControls, {},
                    el( PanelBody, { title: __( 'Settings', '{{PLUGIN_SLUG}}' ) },
                        el( TextControl, {
                            label: __( 'Source URL', '{{PLUGIN_SLUG}}' ),
                            value: attributes.src || '',
                            onChange: ( v ) => setAttributes( { src: v } ),
                        } ),
                        el( TextControl, {
                            label: __( 'Alt text', '{{PLUGIN_SLUG}}' ),
                            value: attributes.alt || '',
                            onChange: ( v ) => setAttributes( { alt: v } ),
                        } ),
                        el( TextareaControl, {
                            label: __( 'Caption', '{{PLUGIN_SLUG}}' ),
                            value: attributes.caption || '',
                            onChange: ( v ) => setAttributes( { caption: v } ),
                        } )
                    )
                ),
                el( 'figure', blockProps,
                    attributes.src
                        ? el( 'img', { src: attributes.src, alt: attributes.alt || '' } )
                        : el( 'em', {}, __( 'Set a source URL in the sidebar.', '{{PLUGIN_SLUG}}' ) ),
                    attributes.caption ? el( 'figcaption', {}, attributes.caption ) : null
                )
            );
        },
        save: function () { return null; }, // Dynamic — frontend via render.php
    } );
} )();
```

**Rules**:

- `save` MUST return `null` — all rendering happens in `render.php`.
- `useBlockProps()` on the outer editor element so the block supports
  system attaches editor classes/styles correctly.
- Use `InspectorControls` + `PanelBody` for the sidebar fields.
- Every string uses `__()` with text domain `{{PLUGIN_SLUG}}`.
- Include **one field per attribute** declared in `block.json`.

### `style.css` — frontend styles

```css
.towp-block-<name> {
    /* Styles matching the source visual output. */
}
.towp-block-<name> img {
    max-width: 100%;
    height: auto;
}
```

Use Liquid source template styling as reference. Keep selectors scoped
to `.towp-block-<name>` to avoid style leaks.

### `editor.css` — editor-only styles

```css
.towp-block-<name> {
    /* Styles to make editing clear in the block editor. */
}
```

Optional but recommended if the default editor rendering looks broken.

---

## Deciding block attributes from Liquid source

For each source template, every Liquid variable reference becomes a block
attribute:

| Liquid source | block.json attribute |
|---|---|
| `{{ include.src }}` | `"src": { "type": "string", "default": "" }` |
| `{{ include.alt }}` | `"alt": { "type": "string", "default": "" }` |
| `{% if include.caption %}` | `"caption": { "type": "string", "default": "" }` |
| `{{ include.width }}` (numeric) | `"width": { "type": "number" }` |
| `{{ include.autoplay }}` (boolean) | `"autoplay": { "type": "boolean", "default": false }` |
| `{% for item in include.items %}` | `"items": { "type": "array", "default": [] }` |

If the source template has no Liquid variables, use default attributes
`{ src, alt, caption }` so generic media shortcodes still work.

---

## Anti-patterns (banned)

- apiVersion 1 or 2 (deprecated — WP 6.9+ needs 3).
- Hard-coded `class=""` without `get_block_wrapper_attributes()`.
- `save()` that returns markup (breaks "Invalid block" saving rules).
- Unescaped output in `render.php`.
- Missing `$schema` in `block.json`.
- Files without the ABSPATH guard.
- Changing the `name` field after first publish (breaks existing content).

---

## Self-check (walk every item)

- [ ] Every shortcode in `{{SHORTCODES_JSON}}` has a directory at
      `{{BLOCKS_DIR}}/<name>/`.
- [ ] Every `block.json` has `"apiVersion": 3` and `"$schema"`.
- [ ] Every `block.json` `"name"` is `{{PLUGIN_SLUG}}/<name>`.
- [ ] Every attribute referenced in the source Liquid template exists in
      `block.json.attributes` with a correct `type`.
- [ ] Every `render.php` calls `get_block_wrapper_attributes()` and
      escapes every attribute output.
- [ ] Every `render.php` starts with `if ( ! defined( 'ABSPATH' ) ) { exit; }`.
- [ ] Every `edit.js` uses `useBlockProps()` and `save()` returns `null`.
- [ ] Every `edit.js` uses text domain `{{PLUGIN_SLUG}}` for i18n.
- [ ] Every `style.css` selector is scoped to `.towp-block-<name>`.
- [ ] No markup-saving blocks (all blocks are dynamic / server-rendered).
- [ ] No placeholder strings, no TODOs, no raw/unescaped output.
