/**
 * MDX → HTML.
 *
 * Handles the markdown subset these docs actually use plus the component
 * vocabulary inherited from the Mintlify authoring format, so the same `.mdx`
 * sources build either way. Keeping the source format unchanged means a future
 * move to (or back to) a hosted renderer is a config change, not a rewrite.
 *
 * Components supported: Card, Columns, Steps/Step, Tabs/Tab, AccordionGroup/
 * Accordion, CodeGroup, Note/Tip/Info/Warning/Check, Frame, Status.
 *
 * Not a general MDX engine. It does not evaluate JSX expressions, and it refuses
 * silently-wrong output: an unrecognised component is rendered visibly as an
 * unknown-block marker so it shows up in review rather than vanishing.
 */

import { escapeHtml, highlight } from "./highlight.mjs";

/** Split frontmatter from body. */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };

  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[kv[1]] = value;
  }
  return { meta, body: text.slice(m[0].length) };
}

// ---------------------------------------------------------------------------
// inline
// ---------------------------------------------------------------------------

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

/**
 * Wrap bare Latin technical identifiers in bidi isolation.
 *
 * In an RTL page, `did:svrp:n:8545027b` or `last_seen` sitting inside an Arabic
 * sentence will otherwise be reordered by the bidi algorithm and read wrong.
 * `<bdi>` pins them. Applied only for RTL locales — it is a no-op elsewhere and
 * there is no reason to add markup nobody needs.
 */
function isolateLatin(html, rtl) {
  if (!rtl) return html;
  return html.replace(
    /(^|[^\w>/-])((?:did:svrp:[\w:]+|[a-z_]+_[a-z_]+|\/v1\/[\w/{}-]+))(?![^<]*>)/g,
    (_, pre, token) => `${pre}<bdi>${token}</bdi>`,
  );
}

export function renderInline(text, ctx = {}) {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const rest = text.slice(i);

    // inline code first — nothing inside it is markup
    if (rest[0] === "`") {
      const end = rest.indexOf("`", 1);
      if (end > 0) {
        out += `<code>${escapeHtml(rest.slice(1, end))}</code>`;
        i += end + 1;
        continue;
      }
    }

    // ![alt](src)
    let m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      out += `<img src="${escapeHtml(m[2])}" alt="${escapeHtml(m[1])}" loading="lazy">`;
      i += m[0].length;
      continue;
    }

    // [text](href)
    m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      const href = resolveHref(m[2], ctx);
      const external = /^https?:\/\//.test(href) && !href.includes("docs.libertynet.ai");
      out +=
        `<a href="${escapeHtml(href)}"` +
        (external ? ' target="_blank" rel="noopener noreferrer"' : "") +
        `>${renderInline(m[1], ctx)}</a>`;
      i += m[0].length;
      continue;
    }

    // **bold**
    m = /^\*\*([^*]+)\*\*/.exec(rest);
    if (m) {
      out += `<strong>${renderInline(m[1], ctx)}</strong>`;
      i += m[0].length;
      continue;
    }

    // *italic* / _italic_
    m = /^\*([^*\n]+)\*/.exec(rest) || /^_([^_\n]+)_/.exec(rest);
    if (m) {
      out += `<em>${renderInline(m[1], ctx)}</em>`;
      i += m[0].length;
      continue;
    }

    // <kbd>, <br> and other passthrough inline HTML we author deliberately
    m = /^<(\/?)(kbd|br|sup|sub|bdi)(\s[^>]*)?>/.exec(rest);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }

    // <Status level="..." />
    m = /^<Status\s+level="([a-z_]+)"\s*\/>/.exec(rest);
    if (m) {
      out += statusPill(m[1], ctx);
      i += m[0].length;
      continue;
    }

    out += escapeHtml(rest[0]);
    i++;
  }

  return isolateLatin(out, ctx.rtl);
}

function resolveHref(href, ctx) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const prefix = ctx.localePrefix ?? "";
  if (href.startsWith("/")) return `${prefix}${href}`.replace(/\/{2,}/g, "/") || "/";
  return href;
}

export function statusPill(level, ctx = {}) {
  const strings = ctx.strings?.status ?? {};
  const label = strings[level] ?? level;
  const help = strings[`${level}Help`] ?? "";
  const cls = level === "not_yet_wired" ? "wired" : level;
  return `<span class="pill pill--${cls}" title="${escapeHtml(help)}">${escapeHtml(label)}</span>`;
}

// ---------------------------------------------------------------------------
// component tags
// ---------------------------------------------------------------------------

function parseAttrs(raw) {
  const attrs = {};
  for (const m of raw.matchAll(/(\w+)=(?:"([^"]*)"|\{([^}]*)\})/g)) {
    attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  for (const m of raw.matchAll(/(?:^|\s)(\w+)(?=\s|$)/g)) {
    if (!(m[1] in attrs)) attrs[m[1]] = true;
  }
  return attrs;
}

/** Find the matching close tag for `name`, honouring nesting. */
function findClose(lines, start, name) {
  let depth = 1;
  const open = new RegExp(`<${name}(\\s|>)`);
  const close = new RegExp(`</${name}>`);

  for (let i = start; i < lines.length; i++) {
    if (open.test(lines[i]) && !new RegExp(`<${name}[^>]*/>`).test(lines[i])) depth++;
    if (close.test(lines[i])) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const CALLOUTS = { Note: "note", Tip: "tip", Info: "info", Warning: "warning", Check: "check" };

/**
 * Does this line end the paragraph being accumulated?
 *
 * The subtle case is components. A line that is *only* a component tag opens a
 * block and ends the paragraph. A line that merely *starts* with an inline
 * component — `<Status level="planned" /> Reserved at …` — is still a paragraph,
 * and treating it as a block silently dropped the entire line.
 *
 * That bug ate the first sentence of two cards on the community page and would
 * have eaten any paragraph opening with a badge. It failed invisibly: the page
 * still rendered, just missing a sentence, which is the worst way for a
 * documentation bug to behave.
 */
function endsParagraph(line) {
  if (/^(#{1,4}\s|```|\||>|---+\s*$)/.test(line)) return true;
  if (/^\s*([-*+]|\d+\.)\s/.test(line)) return true;

  // A component tag alone on its line — opening, closing or self-closing.
  return /^\s*<\/?[A-Z]\w*[^>]*\/?>\s*$/.test(line);
}

// ---------------------------------------------------------------------------
// block renderer
// ---------------------------------------------------------------------------

export function renderBlocks(source, ctx = {}) {
  const lines = source.split(/\r?\n/);
  const headings = [];
  const html = renderRange(lines, 0, lines.length, ctx, headings);
  return { html, headings };
}

function renderRange(lines, from, to, ctx, headings) {
  let out = "";
  let i = from;

  while (i < to) {
    const line = lines[i];

    // blank
    if (!line.trim()) { i++; continue; }

    // import / export statements from the MDX authoring format
    if (/^\s*(import|export)\s/.test(line)) { i++; continue; }

    // fenced code
    let m = /^```(\S+)?\s*(.*)$/.exec(line);
    if (m) {
      const lang = m[1] ?? "text";
      const title = m[2]?.trim() ?? "";
      let j = i + 1;
      const body = [];
      while (j < to && !/^```\s*$/.test(lines[j])) body.push(lines[j++]);
      out += codeBlock(body.join("\n"), lang, title, ctx);
      i = j + 1;
      continue;
    }

    // heading
    m = /^(#{1,4})\s+(.*)$/.exec(line);
    if (m) {
      const level = m[1].length;
      const rendered = renderInline(m[2], ctx);
      const id = slugify(m[2]);
      if (level <= 3) headings.push({ level, id, text: m[2].replace(/<[^>]+>/g, "").trim() });
      out += `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${rendered}</h${level}>`;
      i++;
      continue;
    }

    // horizontal rule
    if (/^---+\s*$/.test(line)) { out += "<hr>"; i++; continue; }

    // component blocks
    m = /^\s*<([A-Z]\w*)([^>]*?)(\/?)>\s*$/.exec(line);
    if (m) {
      const [, name, rawAttrs, selfClose] = m;
      const attrs = parseAttrs(rawAttrs);

      if (selfClose) {
        out += renderComponent(name, attrs, [], ctx, headings);
        i++;
        continue;
      }

      const close = findClose(lines, i + 1, name);
      if (close === -1) {
        // Unbalanced tag — surface it rather than swallowing the rest of the page.
        out += `<div class="unknown-block">Unclosed &lt;${escapeHtml(name)}&gt;</div>`;
        i++;
        continue;
      }
      out += renderComponent(name, attrs, lines.slice(i + 1, close), ctx, headings);
      i = close + 1;
      continue;
    }

    // table
    if (/^\|/.test(line) && i + 1 < to && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      let j = i;
      const rows = [];
      while (j < to && /^\|/.test(lines[j])) rows.push(lines[j++]);
      out += table(rows, ctx);
      i = j;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      let j = i;
      const body = [];
      while (j < to && /^>\s?/.test(lines[j])) body.push(lines[j++].replace(/^>\s?/, ""));
      out += `<blockquote>${renderRange(body, 0, body.length, ctx, headings)}</blockquote>`;
      i = j;
      continue;
    }

    // list
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      let j = i;
      const items = [];
      let current = null;

      while (j < to) {
        const item = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(lines[j]);
        if (item) {
          if (current) items.push(current);
          current = [item[1]];
          j++;
        } else if (/^\s{2,}\S/.test(lines[j]) && current) {
          current.push(lines[j].replace(/^\s{2,}/, ""));
          j++;
        } else if (!lines[j].trim() && current && j + 1 < to && /^\s{2,}\S/.test(lines[j + 1])) {
          current.push("");
          j++;
        } else break;
      }
      if (current) items.push(current);

      const tag = ordered ? "ol" : "ul";
      out += `<${tag}>`;
      for (const item of items) {
        const text = item.join("\n");
        out += `<li>${
          text.includes("\n") ? renderRange(text.split("\n"), 0, text.split("\n").length, ctx, headings) : renderInline(text, ctx)
        }</li>`;
      }
      out += `</${tag}>`;
      i = j;
      continue;
    }

    // paragraph
    let j = i;
    const para = [];
    while (j < to && lines[j].trim() && !endsParagraph(lines[j])) {
      para.push(lines[j++]);
    }
    if (para.length) {
      out += `<p>${renderInline(para.join(" "), ctx)}</p>`;
      i = j;
    } else {
      i++;
    }
  }

  return out;
}

function codeBlock(code, lang, title, ctx) {
  const label = title || lang;
  return (
    `<div class="code" data-lang="${escapeHtml(lang)}">` +
    (label && label !== "text" ? `<div class="code__bar"><span>${escapeHtml(label)}</span>` : `<div class="code__bar"><span></span>`) +
    `<button class="code__copy" type="button" data-copy>${escapeHtml(ctx.strings?.nav?.copyPage ?? "Copy")}</button></div>` +
    `<pre><code>${highlight(code, lang)}</code></pre>` +
    `</div>`
  );
}

function table(rows, ctx) {
  const cells = (row) =>
    row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  const header = cells(rows[0]);
  const body = rows.slice(2).map(cells);

  let out = '<div class="table-wrap"><table><thead><tr>';
  for (const h of header) out += `<th>${renderInline(h, ctx)}</th>`;
  out += "</tr></thead><tbody>";
  for (const row of body) {
    out += "<tr>";
    for (let k = 0; k < header.length; k++) out += `<td>${renderInline(row[k] ?? "", ctx)}</td>`;
    out += "</tr>";
  }
  return out + "</tbody></table></div>";
}

function renderComponent(name, attrs, body, ctx, headings) {
  const inner = () => renderRange(body, 0, body.length, ctx, headings);

  if (name in CALLOUTS) {
    const kind = CALLOUTS[name];
    const label = ctx.strings?.callout?.[kind] ?? kind;
    return `<div class="callout callout--${kind}" role="note"><div class="callout__label">${escapeHtml(label)}</div><div class="callout__body">${inner()}</div></div>`;
  }

  switch (name) {
    case "Card": {
      const href = attrs.href ? resolveHref(attrs.href, ctx) : null;
      const tag = href ? "a" : "div";
      const attr = href ? ` href="${escapeHtml(href)}"` : "";
      return (
        `<${tag} class="card${attrs.horizontal ? " card--h" : ""}"${attr}>` +
        (attrs.title ? `<div class="card__title">${renderInline(attrs.title, ctx)}</div>` : "") +
        `<div class="card__body">${inner()}</div></${tag}>`
      );
    }
    case "Columns":
      return `<div class="columns" style="--cols:${escapeHtml(String(attrs.cols ?? 2))}">${inner()}</div>`;

    case "Steps":
      return `<ol class="steps">${inner()}</ol>`;

    case "Step":
      return `<li class="step"><div class="step__title">${renderInline(attrs.title ?? "", ctx)}</div><div class="step__body">${inner()}</div></li>`;

    case "Frame":
      return `<figure class="frame">${inner()}</figure>`;

    case "CodeGroup":
    case "Tabs": {
      // Both render as a tab strip. CodeGroup labels come from each fence's title.
      const panels = [];
      let i = 0;
      while (i < body.length) {
        const fence = /^```(\S+)?\s*(.*)$/.exec(body[i]);
        const tab = /^\s*<Tab\s+title="([^"]*)"\s*>\s*$/.exec(body[i]);

        if (fence) {
          const lang = fence[1] ?? "text";
          const label = (fence[2] || lang).trim();
          let j = i + 1;
          const code = [];
          while (j < body.length && !/^```\s*$/.test(body[j])) code.push(body[j++]);
          panels.push({ label, html: codeBlock(code.join("\n"), lang, "", ctx) });
          i = j + 1;
        } else if (tab) {
          const close = findClose(body, i + 1, "Tab");
          const content = body.slice(i + 1, close === -1 ? body.length : close);
          panels.push({
            label: tab[1],
            html: renderRange(content, 0, content.length, ctx, headings),
          });
          i = close === -1 ? body.length : close + 1;
        } else {
          i++;
        }
      }
      if (panels.length === 0) return inner();

      const gid = `tg${Math.abs(hash(panels.map((p) => p.label).join("|")))}`;
      let out = `<div class="tabs" data-tabs><div class="tabs__strip" role="tablist">`;
      panels.forEach((p, k) => {
        out += `<button class="tabs__tab" role="tab" type="button" aria-selected="${k === 0}" aria-controls="${gid}-${k}">${escapeHtml(p.label)}</button>`;
      });
      out += "</div>";
      panels.forEach((p, k) => {
        out += `<div class="tabs__panel" id="${gid}-${k}" role="tabpanel"${k === 0 ? "" : " hidden"}>${p.html}</div>`;
      });
      return out + "</div>";
    }

    case "AccordionGroup":
      return `<div class="accordions">${inner()}</div>`;

    case "Accordion":
      return `<details class="accordion"><summary>${renderInline(attrs.title ?? "", ctx)}</summary><div class="accordion__body">${inner()}</div></details>`;

    case "Tab":
      return inner();

    case "Status":
      return statusPill(attrs.level, ctx);

    case "StatusKey": {
      const s = ctx.strings?.status ?? {};
      let out = '<div class="table-wrap"><table><tbody>';
      for (const level of ["implemented", "not_yet_wired", "testing", "planned"]) {
        out += `<tr><td>${statusPill(level, ctx)}</td><td>${escapeHtml(s[`${level}Help`] ?? "")}</td></tr>`;
      }
      return out + "</tbody></table></div>";
    }

    default:
      // Visible rather than silent: an unknown component should be noticed.
      return `<div class="unknown-block">Unknown component &lt;${escapeHtml(name)}&gt;</div>${inner()}`;
  }
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Plain text, for search indexing and llms.txt. */
export function toPlainText(source) {
  return source
    .replace(/^---[\s\S]*?---\n/, "")
    .replace(/^\s*(import|export)\s.*$/gm, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*`_|>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
