// Crowe Logic desktop - documents from Markdown. Pure Node, no Electron: the
// harness's export_document tool turns the model's Markdown into a standalone
// HTML page here, and main.js prints that page to PDF where Chromium lives.
//
// Dependency-free on purpose. The renderer has its own Markdown pass for chat
// bubbles, but it is a browser script wired to the DOM at load, not a module,
// and a document has different needs from a bubble: a whole page with its own
// stylesheet, heading ids for a PDF outline, and a stricter idea of what a link
// or an image may point at, because this file leaves the app and is opened
// wherever the user takes it.
const fs = require("fs");
const path = require("path");

const FORMATS = { pdf: "pdf", html: "html", md: "md" };
const MAX_MARKDOWN_CHARS = 400000;   // a long report is 60k; this is a book
const MAX_NAME_CHARS = 80;
const MAX_SIBLINGS = 1000;

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function unesc(s) { return String(s).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e])); }

// ─── Destinations ────────────────────────────────────────────────────────────
/* An allowlist, not a blocklist. A link needs a click, so http, https, mailto
   and an in-document anchor are enough; a relative target becomes a file
   reference the moment the export is opened from disk, and a protocol-relative
   one is a network address wearing no scheme. Whitespace and control characters
   are stripped first because Chromium strips them too, so "java\nscript:" would
   otherwise pass a check that "javascript:" fails. */
const LINK_RE = /^(https?:\/\/\S+|mailto:\S+|#\S*)$/i;
function safeHref(raw) {
  const u = String(raw || "").replace(/[\u0000-\u0020\u007f]/g, "");
  return LINK_RE.test(u) ? u : null;
}
/* An image fetches without a click, so a remote source in a document is an
   outbound request the model composed - the same channel open_url asks about
   before opening. Only embedded raster data is drawn; anything else is written
   out as text, so the reader still sees what was meant to be there. */
const IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
function safeImageSrc(raw) {
  const u = String(raw || "").replace(/[\u0000-\u0020\u007f]/g, "");
  return IMAGE_RE.test(u) ? u : null;
}

// ─── Inline ──────────────────────────────────────────────────────────────────
/* Everything is escaped before any markup is recognised, so raw HTML in the
   source is text in the output; there is no passthrough. Code spans, links and
   images are set aside as placeholders while emphasis runs, because a URL such
   as /__init__/ is not a request for bold. */
const HOLD = (n) => `\u0000${n}\u0000`;
function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/\*(?=[^*\s])([^*\n]*?[^*\s])\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_(?=[^_\s])([^_\n]*?[^_\s])_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/(?: {2,}|\\)\n/g, "<br>\n");
}
function inline(text) {
  const keep = [];
  const hold = (html) => { keep.push(html); return HOLD(keep.length - 1); };
  const src = String(text);
  let s = "", last = 0, m;
  const code = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
  while ((m = code.exec(src))) {
    s += esc(src.slice(last, m.index));
    const c = m[2];
    const inner = c.length > 2 && c.startsWith(" ") && c.endsWith(" ") && c.trim() ? c.slice(1, -1) : c;
    s += hold(`<code>${esc(inner)}</code>`);
    last = m.index + m[0].length;
  }
  s += esc(src.slice(last));
  const DEST = "((?:[^()\\s]|\\([^()\\s]*\\))+)";
  const TITLE = "(?:\\s+&quot;([^&]*)&quot;)?";
  s = s.replace(new RegExp(`!\\[([^\\]]*)\\]\\(${DEST}${TITLE}\\)`, "g"), (_, alt, dest) => {
    const u = safeImageSrc(unesc(dest));
    if (u) return hold(`<img src="${esc(u)}" alt="${alt}">`);
    return hold(`<span class="image-ref">[image: ${alt ? `${alt} (${dest})` : dest}]</span>`);
  });
  s = s.replace(new RegExp(`\\[([^\\]]+)\\]\\(${DEST}${TITLE}\\)`, "g"), (_, label, dest, title) => {
    const u = safeHref(unesc(dest));
    if (u) return hold(`<a href="${esc(u)}"${title ? ` title="${title}"` : ""}>${emphasis(label)}</a>`);
    return `${label} (${hold(dest)})`;
  });
  s = s.replace(/&lt;(https?:\/\/[^\s<>]+?)&gt;/gi, (_, dest) => {
    const u = safeHref(unesc(dest));
    return u ? hold(`<a href="${esc(u)}">${dest}</a>`) : `&lt;${dest}&gt;`;
  });
  s = emphasis(s);
  for (let i = 0; i < 4 && s.includes("\u0000"); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => keep[n]);
  return s;
}
function plainText(raw) {
  return String(raw).replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_~]/g, "").trim();
}

// ─── Blocks ──────────────────────────────────────────────────────────────────
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const RULE_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)\s*$/;
const QUOTE_RE = /^ {0,3}>/;
const ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const leading = (l) => /^\s*/.exec(l)[0].length;
const startsBlock = (l) => FENCE_RE.test(l) || HEADING_RE.test(l) || RULE_RE.test(l) || QUOTE_RE.test(l) || ITEM_RE.test(l);

function slugFor(text, ids) {
  const base = plainText(text).toLowerCase().replace(/[^a-z0-9\u00c0-\uffff]+/g, "-").replace(/^-+|-+$/g, "") || "section";
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  ids.add(id);
  return id;
}
function heading(level, text, ids) { return `<h${level} id="${slugFor(text, ids)}">${inline(text)}</h${level}>`; }

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "\\" && s[k + 1] === "|") { cur += "|"; k++; }
    else if (s[k] === "|") { cells.push(cur.trim()); cur = ""; }
    else cur += s[k];
  }
  cells.push(cur.trim());
  return cells;
}
function table(lines, i) {
  const head = splitRow(lines[i]);
  const sep = splitRow(lines[i + 1]);
  if (sep.length !== head.length || sep.some((c) => !/^:?-+:?$/.test(c))) return null;
  const align = sep.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
  const cls = (k) => (align[k] && align[k] !== "left" ? ` class="align-${align[k]}"` : "");
  const rows = [];
  let j = i + 2;
  while (j < lines.length && lines[j].trim() && lines[j].includes("|") && !startsBlock(lines[j])) {
    const cells = splitRow(lines[j]);
    rows.push(head.map((_, k) => cells[k] ?? ""));
    j++;
  }
  const html = "<table>\n<thead><tr>" + head.map((c, k) => `<th${cls(k)}>${inline(c)}</th>`).join("") + "</tr></thead>\n"
    + (rows.length ? "<tbody>\n" + rows.map((r) => "<tr>" + r.map((c, k) => `<td${cls(k)}>${inline(c)}</td>`).join("") + "</tr>").join("\n") + "\n</tbody>\n" : "")
    + "</table>";
  return { html, next: j };
}

/* Items are collected by marker indent; whatever sits deeper under an item is
   its body and is rendered as Markdown in its own right, which is how nested
   lists, paragraphs and code blocks inside an item all come for free. A plain
   line straight after an item continues it, as it does in every editor. */
function list(lines, i, ids) {
  const first = ITEM_RE.exec(lines[i]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  while (i < lines.length) {
    const m = ITEM_RE.exec(lines[i]);
    if (m && m[1].length === indent && /\d/.test(m[2]) === ordered) {
      items.push({ head: m[3], body: [], content: indent + m[2].length + 1 });
      i++; continue;
    }
    const cur = items[items.length - 1];
    if (!lines[i].trim()) {
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && leading(lines[j]) > indent) { cur.body.push(""); i++; continue; }
      break;
    }
    const lead = leading(lines[i]);
    if (lead > indent) {
      const rest = lines[i].slice(Math.min(lead, cur.content));
      if (!cur.body.length && !startsBlock(rest)) cur.head += "\n" + rest.trim(); else cur.body.push(rest);
      i++; continue;
    }
    if (!cur.body.length && !startsBlock(lines[i])) { cur.head += "\n" + lines[i].trim(); i++; continue; }
    break;
  }
  const html = items.map((it) => {
    let head = it.head, box = "";
    const t = /^\[([ xX])\]\s+([\s\S]*)$/.exec(head);
    if (t) { box = `<input type="checkbox" disabled${t[1] === " " ? "" : " checked"}> `; head = t[2]; }
    const body = it.body.join("\n").trim() ? "\n" + blocks(it.body, ids) : "";
    return `<li>${box}${inline(head)}${body}</li>`;
  }).join("\n");
  const tag = ordered ? "ol" : "ul";
  const start = ordered ? parseInt(first[2], 10) : 1;
  return { html: `<${tag}${start !== 1 ? ` start="${start}"` : ""}>\n${html}\n</${tag}>`, next: i };
}

function blocks(lines, ids) {
  const out = [];
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join("\n"))}</p>`); para.length = 0; } };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = FENCE_RE.exec(line))) {
      flush();
      const close = new RegExp(`^ {0,3}\\${m[1][0]}{${m[1].length},}\\s*$`);
      const buf = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      const lang = m[2] ? ` class="language-${esc(m[2])}"` : "";
      out.push(`<pre><code${lang}>${esc(buf.join("\n"))}\n</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    if (para.length && (m = SETEXT_RE.exec(line))) {
      const text = para.join(" "); para.length = 0;
      out.push(heading(m[1][0] === "=" ? 1 : 2, text, ids)); i++; continue;
    }
    if ((m = HEADING_RE.exec(line))) { flush(); out.push(heading(m[1].length, m[2], ids)); i++; continue; }
    if (RULE_RE.test(line)) { flush(); out.push("<hr>"); i++; continue; }
    if (QUOTE_RE.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) buf.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      out.push(`<blockquote>\n${blocks(buf, ids)}\n</blockquote>`); continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const t = table(lines, i);
      if (t) { flush(); out.push(t.html); i = t.next; continue; }
    }
    if (ITEM_RE.test(line) && !RULE_RE.test(line)) { flush(); const l = list(lines, i, ids); out.push(l.html); i = l.next; continue; }
    para.push(line); i++;
  }
  flush();
  return out.join("\n");
}
function markdownToHtml(markdown) {
  const lines = String(markdown ?? "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n").split("\n")
    .map((l) => l.replace(/^\t+/, (t) => "    ".repeat(t.length)));
  return blocks(lines, new Set());
}

// ─── The page ────────────────────────────────────────────────────────────────
/* The policy travels with the file. The print window in main.js refuses every
   network request on its own, but an exported .html is opened in whatever
   browser the user has, and that browser would fetch a remote image; this meta
   says no on the page's behalf. Inline styles are the page's own and the only
   ones. */
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
const STYLE = `
@page { size: Letter; margin: 0.8in 0.9in; }
:root { color-scheme: light; }
html { font-size: 11pt; }
body { margin: 0; background: #FBF9F4; color: #121212; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.55; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
main.document { max-width: 46rem; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
h1, h2, h3, h4, h5, h6 { font-family: Fraunces, Georgia, "Times New Roman", serif; font-weight: 600; line-height: 1.2; letter-spacing: -0.01em; color: #121212; margin: 1.8em 0 0.5em; break-after: avoid; }
h1 { font-size: 2.1em; margin-top: 0; padding-bottom: 0.35em; border-bottom: 1px solid #DED8CD; }
h2 { font-size: 1.5em; } h3 { font-size: 1.2em; } h4 { font-size: 1.05em; } h5, h6 { font-size: 1em; }
h1 + h2, h2 + h3, h3 + h4 { margin-top: 0.8em; }
p { margin: 0 0 0.9em; }
a { color: #7A663C; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
code, pre, kbd { font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; font-size: 0.92em; }
code { background: #F4F0E7; padding: 0.1em 0.35em; border-radius: 3px; }
pre { background: #F4F0E7; border: 1px solid #DED8CD; border-radius: 6px; padding: 0.85em 1em; margin: 0 0 1em; overflow-x: auto; line-height: 1.45; break-inside: avoid; }
pre code { background: none; padding: 0; font-size: 0.9em; white-space: pre; }
blockquote { margin: 1em 0; padding: 0.2em 1em; border-left: 3px solid #B99A5B; color: #6E6962; }
blockquote > :last-child { margin-bottom: 0; }
ul, ol { margin: 0 0 0.9em; padding-left: 1.6em; }
li { margin: 0.2em 0; }
li > ul, li > ol { margin: 0.2em 0; }
li > p { margin: 0.3em 0; }
li input[type=checkbox] { margin: 0 0.4em 0 0; vertical-align: -1px; }
hr { border: 0; border-top: 1px solid #DED8CD; margin: 2em 0; }
table { border-collapse: collapse; width: 100%; margin: 1em 0 1.4em; font-size: 0.95em; }
th, td { border: 1px solid #DED8CD; padding: 0.45em 0.7em; text-align: left; vertical-align: top; }
th { background: #F4F0E7; font-weight: 600; }
tr { break-inside: avoid; }
.align-center { text-align: center; } .align-right { text-align: right; }
img { max-width: 100%; height: auto; }
.image-ref { color: #6E6962; font-style: italic; }
del { color: #6E6962; }
@media print { body { background: #fff; } main.document { max-width: none; padding: 0; } a { color: inherit; } }
`.trim();

/* The title is the first heading if there is one, whatever its level, read
   outside code fences so a commented shell line is not mistaken for one. */
function documentTitle(markdown, given, fallback) {
  const g = String(given || "").trim();
  if (g) return g.slice(0, 200);
  let fence = null;
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    const f = FENCE_RE.exec(line);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
    if (fence) continue;
    const h = HEADING_RE.exec(line);
    if (h) return plainText(h[2]).slice(0, 200) || fallback;
  }
  return fallback;
}
function documentHtml(markdown, opts = {}) {
  const title = String(opts.title || "").trim() || "Document";
  return [
    "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="Crowe Logic">',
    `<title>${esc(title)}</title>`, "<style>", STYLE, "</style>", "</head>", "<body>", '<main class="document">',
    markdownToHtml(markdown), "</main>", "</body>", "</html>", "",
  ].join("\n");
}

// ─── Where it goes ───────────────────────────────────────────────────────────
/* The tool takes a name, not a path. Directories are dropped from either kind
   of separator, the extension is the format's and never the caller's, and the
   Windows device names are prefixed rather than refused, since NUL.pdf is a
   name a person could type in good faith and a file nothing can open. Trimmed
   again after the cap because a cut can leave a trailing dot behind. */
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const trimEnds = (s) => s.replace(/^[\s.-]+|[\s.-]+$/g, "");
function exportFileName(name) {
  let s = String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, "");
  s = s.split(/[\\/]/).filter((seg) => seg.trim()).pop() || "";
  s = s.replace(/\.(pdf|html?|md|markdown|txt)$/i, "");
  s = s.replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/-{2,}/g, "-").replace(/ {2,}/g, " ");
  s = trimEnds(trimEnds(s).slice(0, MAX_NAME_CHARS));
  if (RESERVED_RE.test(s)) s = `document-${s}`;
  return s || "document";
}
/* Never over something that exists. Exclusive creation rather than a stat and a
   write, so two turns exporting the same name at once each keep their file. */
async function saveExport(dir, stem, ext, bytes) {
  await fs.promises.mkdir(dir, { recursive: true });
  for (let n = 1; n <= MAX_SIBLINGS; n++) {
    const file = path.join(dir, `${stem}${n > 1 ? `-${n}` : ""}.${ext}`);
    try {
      await fs.promises.writeFile(file, bytes, { flag: "wx", mode: 0o644 });
      return { file, renamed: n > 1 };
    } catch (e) { if (!e || e.code !== "EEXIST") throw e; }
  }
  throw new Error(`exports/ already holds ${MAX_SIBLINGS} documents named ${stem}`);
}

module.exports = {
  FORMATS, MAX_MARKDOWN_CHARS, MAX_NAME_CHARS, CSP,
  esc, safeHref, safeImageSrc, inline, plainText, markdownToHtml, documentTitle, documentHtml,
  exportFileName, saveExport,
};
