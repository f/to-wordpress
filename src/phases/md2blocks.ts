import { marked, type Tokens } from "marked";

/**
 * Convert markdown into a Gutenberg-block HTML string. We map common tokens to
 * the corresponding core block comment wrappers (`<!-- wp:paragraph -->…<!-- /wp:paragraph -->`)
 * so the WordPress editor treats imported content as proper blocks rather than
 * classic HTML. Unknown/complex tokens fall back to `core/html`.
 */
export function markdownToBlocks(md: string): string {
  const tokens = marked.lexer(md);
  const out: string[] = [];
  for (const tok of tokens) {
    const block = tokenToBlock(tok);
    if (block) out.push(block);
  }
  return out.join("\n\n");
}

function tokenToBlock(tok: Tokens.Generic): string {
  switch (tok.type) {
    case "heading": {
      const t = tok as Tokens.Heading;
      const level = Math.min(6, Math.max(1, t.depth));
      const html = `<h${level}>${inline(t.tokens)}</h${level}>`;
      return wrap("heading", html, level !== 2 ? { level } : undefined);
    }
    case "paragraph": {
      const t = tok as Tokens.Paragraph;
      const text = inline(t.tokens);
      const imgOnly = /^<img\b[^>]*>$/.test(text.trim());
      if (imgOnly) {
        return wrap("image", `<figure class="wp-block-image">${text}</figure>`);
      }
      return wrap("paragraph", `<p>${text}</p>`);
    }
    case "code": {
      const t = tok as Tokens.Code;
      const code = escapeHtml(t.text);
      const lang = t.lang ? ` language-${t.lang}` : "";
      return wrap("code", `<pre class="wp-block-code"><code class="${lang.trim()}">${code}</code></pre>`);
    }
    case "blockquote": {
      const t = tok as Tokens.Blockquote;
      const inner = (t.tokens ?? [])
        .map((sub) => tokenToBlock(sub))
        .filter(Boolean)
        .join("\n");
      return wrap("quote", `<blockquote class="wp-block-quote">${inner || `<p>${inline(t.tokens ?? [])}</p>`}</blockquote>`);
    }
    case "list": {
      const t = tok as Tokens.List;
      const tag = t.ordered ? "ol" : "ul";
      const lis = t.items
        .map((item) => `<li>${inline(item.tokens ?? [])}</li>`)
        .join("");
      return wrap("list", `<${tag}>${lis}</${tag}>`, t.ordered ? { ordered: true } : undefined);
    }
    case "hr":
      return wrap("separator", `<hr class="wp-block-separator has-alpha-channel-opacity"/>`);
    case "html": {
      const t = tok as Tokens.HTML;
      return wrap("html", t.text);
    }
    case "table": {
      const t = tok as Tokens.Table;
      const header = t.header
        .map((cell) => `<th>${inline(cell.tokens ?? [])}</th>`)
        .join("");
      const body = t.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell.tokens ?? [])}</td>`).join("")}</tr>`)
        .join("");
      return wrap("table", `<figure class="wp-block-table"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></figure>`);
    }
    case "space":
      return "";
    default: {
      const generic = tok as Tokens.Generic;
      const text = (generic.raw ?? "").trim();
      if (!text) return "";
      return wrap("html", text);
    }
  }
}

function inline(tokens: Tokens.Generic[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens && tt.tokens.length > 0) out += inline(tt.tokens);
        else out += tt.text;
        break;
      }
      case "paragraph":
        out += inline((t as Tokens.Paragraph).tokens);
        break;
      case "strong":
        out += `<strong>${inline((t as Tokens.Strong).tokens)}</strong>`;
        break;
      case "em":
        out += `<em>${inline((t as Tokens.Em).tokens)}</em>`;
        break;
      case "codespan":
        out += `<code>${escapeHtml((t as Tokens.Codespan).text)}</code>`;
        break;
      case "del":
        out += `<del>${inline((t as Tokens.Del).tokens)}</del>`;
        break;
      case "link": {
        const l = t as Tokens.Link;
        out += `<a href="${escapeAttr(l.href)}"${l.title ? ` title="${escapeAttr(l.title)}"` : ""}>${inline(l.tokens)}</a>`;
        break;
      }
      case "image": {
        const i = t as Tokens.Image;
        out += `<img src="${escapeAttr(i.href)}" alt="${escapeAttr(i.text)}"${i.title ? ` title="${escapeAttr(i.title)}"` : ""}/>`;
        break;
      }
      case "br":
        out += "<br/>";
        break;
      case "html":
        out += (t as Tokens.HTML).text;
        break;
      default:
        out += (t as Tokens.Generic).raw ?? "";
    }
  }
  return out;
}

function wrap(name: string, inner: string, attrs?: Record<string, unknown>): string {
  const payload = attrs && Object.keys(attrs).length > 0 ? " " + JSON.stringify(attrs) : "";
  return `<!-- wp:${name}${payload} -->\n${inner}\n<!-- /wp:${name} -->`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
