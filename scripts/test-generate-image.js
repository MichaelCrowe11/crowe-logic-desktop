// Headless tests for the generate_image tool. Pure Node, no Electron, and no
// network past the loopback interface: the provider is a stubbed fetch handed in
// through ctx.fetch, or the real fetch pointed at a local socket where the shape
// of a failure is the thing under test; the key comes from a stubbed
// ctx.imageCredential, and the workspace is a temp directory. What is pinned
// here: the file lands under assets/generated in the workspace, the tool sits at
// the Edit tier, every call asks the user first in every approval mode but "off"
// and a denial leaves nothing behind, not even the directory,
// a failure names the code or the timeout the way Node's fetch really throws it,
// the saved file is on the rollback list by name, and the key never appears in
// anything the tool hands back. Also: a prompt over the limit is refused rather
// than cut, the tool card the renderer draws gets a credential's value cut the
// way the approval card does, and a response over the body cap stops the
// download rather than buffering it.
//
//   node scripts/test-generate-image.js
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/test-generate-image.js
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const H = require("../harness");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const SECRET = "sk-test-KEEP-OUT-OF-OUTPUT-4f9c";
// A 1x1 PNG, the smallest valid one.
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const ROUTER = () => ({ provider: "openrouter", secret: SECRET });

function workspace() { return fs.mkdtempSync(path.join(os.tmpdir(), "crowe-image-")); }
// A fetch stub that records what it was asked and answers with `answer`.
function stubFetch(answer) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    if (answer.throws) throw answer.throws;
    const status = answer.status || 200;
    // A stream, as fetch hands one over: the tool reads the body through a byte
    // cap rather than through json().
    const bytes = Buffer.from(JSON.stringify(answer.body === undefined ? null : answer.body));
    return { ok: status >= 200 && status < 300, status, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
  };
  f.calls = calls;
  return f;
}
// The real fetch, pointed at a local socket instead of the provider. The init,
// signal included, goes through untouched, so what the tool catches is exactly
// what Node's fetch throws.
function localFetch(port) {
  const f = (url, init) => { f.calls.push({ url, init }); return globalThis.fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init); };
  f.calls = [];
  return f;
}
function listen(handler) { return new Promise((resolve) => { const srv = http.createServer(handler); srv.listen(0, "127.0.0.1", () => resolve(srv)); }); }
function stop(srv) { return new Promise((resolve) => { srv.closeAllConnections(); srv.close(() => resolve()); }); }
async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
function makeCtx(cfgPatch = {}, hooks = {}) {
  const { approve, ...rest } = hooks;
  const dir = rest.dir || workspace();
  const cfg = { autonomy: "edit", approvals: "high-risk", verifier: false, turnBudgetUsd: 0, autoApprove: true, ...cfgPatch };
  const ctx = {
    dir, journalEvents: [], approvalsSeen: [],
    getCwd: () => dir, setCwd: () => {},
    loadConfig: () => cfg,
    proposeEdit: async () => "applied edit",
    mcpTools: () => [], mcpCall: async () => "", openUrl: () => {},
    journal: (ev) => ctx.journalEvents.push(ev),
    artifactDir: () => path.join(dir, ".artifacts"),
    imageCredential: () => ({ provider: "openai", secret: SECRET }),
    fetch: stubFetch({ body: { data: [{ b64_json: PNG_1x1 }] } }),
    ...rest,
  };
  // The tool asks before every call, so the fixture says yes unless a test says
  // otherwise: approve false denies, approve null is a build with no way to ask.
  if (approve !== null) ctx.requestApproval = async (req) => { ctx.approvalsSeen.push(req); return { approved: approve !== false }; };
  return ctx;
}
const state = (ctx) => H.newState(ctx, ctx.loadConfig(), {}, { expert: "operator", model: "m" });
const run = (ctx, args, route = {}) => H.callTool(ctx, "generate_image", args, route, state(ctx));
// Everything the tool let out of the function: result text, the journal, and the approval cards.
const everything = (ctx, out) => out.text + JSON.stringify(ctx.journalEvents) + JSON.stringify(ctx.approvalsSeen);
const generatedDir = (ctx) => path.join(ctx.dir, "assets", "generated");
const nothingSaved = (ctx) => !fs.existsSync(generatedDir(ctx)) || fs.readdirSync(generatedDir(ctx)).length === 0;

test("the tool is offered to the operator, not to the verifier, is classed compensatable, and says it asks first", () => {
  const ctx = makeCtx({ autonomy: "execute" });
  const spec = H.BUILTIN_TOOLS.find((t) => t.function.name === "generate_image");
  assert.ok(spec);
  assert.match(spec.function.description, /billed to the user's key and asked about first/);
  assert.match(H.TIER_LINES.edit, /generate_image, which asks the user before each call/);
  assert.ok(H.allTools(ctx, {}).some((t) => t.function.name === "generate_image"));
  assert.ok(!H.verifierTools(ctx).some((t) => t.function.name === "generate_image"));
  assert.strictEqual(H.deliveryOf(ctx, "generate_image", { prompt: "x" }), "compensatable");
});

test("saves the PNG under assets/generated in the workspace and reports path, size, provider, and a description", async () => {
  const ctx = makeCtx();
  const out = await run(ctx, { prompt: "a spore print on black card", filename: "spore-print" });
  const rel = path.join("assets", "generated", "spore-print.png");
  assert.strictEqual(out.status, "SUCCESS");
  assert.ok(out.text.startsWith(`generated ${rel} (1x1, OpenAI gpt-image-1`), out.text);
  assert.match(out.text, /not in the turn meter\)\na spore print on black card$/);
  const abs = path.join(ctx.dir, rel);
  assert.ok(fs.existsSync(abs), "file written");
  assert.strictEqual(fs.readFileSync(abs).toString("base64"), PNG_1x1);
  assert.strictEqual(ctx.approvalsSeen.length, 1, "asked once, in the default approval mode");
  const call = ctx.fetch.calls[0];
  assert.strictEqual(call.url, "https://api.openai.com/v1/images/generations");
  assert.strictEqual(call.init.headers.Authorization, `Bearer ${SECRET}`, "the key rides in the one header");
  assert.strictEqual(call.init.redirect, "error");
  assert.ok(call.init.signal instanceof AbortSignal, "a timeout signal is handed to fetch");
  const body = JSON.parse(call.init.body);
  assert.deepStrictEqual(body, { model: "gpt-image-1", prompt: "a spore print on black card", n: 1, size: "1024x1024", output_format: "png" });
});

test("the key appears nowhere in the result, the journal, or the approval request", async () => {
  const ctx = makeCtx({ approvals: "strict" });
  const out = await run(ctx, { prompt: "a tiny mushroom" });
  assert.strictEqual(out.status, "SUCCESS");
  assert.strictEqual(ctx.approvalsSeen.length, 1);
  assert.ok(!everything(ctx, out).includes(SECRET));
  assert.ok(!everything(ctx, out).includes("KEEP-OUT"));
});

test("a provider error body is never quoted, even when it echoes the key", async () => {
  const ctx = makeCtx({}, { fetch: stubFetch({ status: 401, body: { error: { code: "invalid_api_key", message: `Incorrect API key provided: ${SECRET}` } } }) });
  const out = await run(ctx, { prompt: "anything" });
  assert.strictEqual(out.status, "FAIL");
  assert.strictEqual(out.text, "error: OpenAI answered HTTP 401 (invalid_api_key). The key was refused; test it in Settings > Keys. No file was written.");
  assert.ok(!everything(ctx, out).includes(SECRET));
  assert.ok(nothingSaved(ctx));
});

test("a failure is named the way Node's fetch throws it: the code from the cause chain, the timeout from the signal or the name", async () => {
  // Node's fetch does not throw the socket error. It throws TypeError("fetch
  // failed") and keeps the socket error in cause, inside an AggregateError when
  // more than one address was tried.
  const refused = new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:443 ${SECRET}`), { code: "ECONNREFUSED" }) });
  const a = makeCtx({}, { fetch: stubFetch({ throws: refused }) });
  const out = await run(a, { prompt: "x" });
  assert.strictEqual(out.text, "error: OpenAI could not be reached (ECONNREFUSED). No file was written.");
  assert.ok(!everything(a, out).includes(SECRET));
  const many = new TypeError("fetch failed", { cause: new AggregateError([Object.assign(new Error("::1"), { code: "ECONNREFUSED" }), Object.assign(new Error("127.0.0.1"), { code: "ECONNREFUSED" })], "") });
  assert.strictEqual((await run(makeCtx({}, { fetch: stubFetch({ throws: many }) }), { prompt: "x" })).text, "error: OpenAI could not be reached (ECONNREFUSED). No file was written.");
  assert.strictEqual(H.errCode(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }) })), "ENOTFOUND");
  assert.strictEqual(H.errCode(new TypeError("fetch failed")), "TypeError");
  assert.strictEqual(H.errCode(Object.assign(new Error("x"), { code: "weird code; rm -rf /" })), "weirdcoderm-rf");
  // A timeout is a DOMException named TimeoutError whose code is the number 23,
  // which a string comparison on code never matched.
  const late = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.strictEqual(late.code, 23);
  const b = makeCtx({}, { fetch: stubFetch({ throws: late }) });
  assert.strictEqual((await run(b, { prompt: "x" })).text, "error: OpenAI did not answer within 120s. No file was written; the provider may still have billed the request.");
  const wrapped = new TypeError("fetch failed", { cause: late });
  assert.strictEqual((await run(makeCtx({}, { fetch: stubFetch({ throws: wrapped }) }), { prompt: "x" })).text, "error: OpenAI did not answer within 120s. No file was written; the provider may still have billed the request.");
});

test("against a real socket: a closed port is ECONNREFUSED, a provider that never answers or never finishes is a timeout, and nothing is written", async () => {
  const port = await closedPort();
  const refused = makeCtx({}, { fetch: localFetch(port) });
  const out = await run(refused, { prompt: "x" });
  assert.strictEqual(out.text, "error: OpenAI could not be reached (ECONNREFUSED). No file was written.");
  assert.ok(!everything(refused, out).includes(SECRET));
  const silent = await listen(() => { /* accept the request and never answer it */ });
  const slow = makeCtx({}, { fetch: localFetch(silent.address().port), imageTimeoutMs: 200 });
  try {
    const out2 = await run(slow, { prompt: "x" });
    assert.strictEqual(out2.text, "error: OpenAI did not answer within 200 ms. No file was written; the provider may still have billed the request.");
    assert.ok(!everything(slow, out2).includes(SECRET));
    assert.ok(nothingSaved(slow));
  } finally { await stop(silent); }
  const half = await listen((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"data":[{"b64_json":"'); });
  const cut = makeCtx({}, { fetch: localFetch(half.address().port), imageTimeoutMs: 200 });
  try {
    const out3 = await run(cut, { prompt: "x" });
    assert.strictEqual(out3.text, "error: OpenAI did not finish answering within 200 ms. No file was written; the provider may still have billed the request.");
    assert.ok(nothingSaved(cut));
  } finally { await stop(half); }
});

test("no key configured: a plain message naming Settings > Keys, and no request is sent", async () => {
  const ctx = makeCtx({}, { imageCredential: () => null });
  const out = await run(ctx, { prompt: "x" });
  assert.strictEqual(out.text, "No image provider key is configured. Ask the user to add an OpenAI or OpenRouter key in Settings > Keys, then try again.");
  assert.strictEqual(ctx.fetch.calls.length, 0);
  assert.strictEqual(ctx.approvalsSeen.length, 0);
  const noHook = makeCtx(); delete noHook.imageCredential;
  assert.match((await run(noHook, { prompt: "x" })).text, /^No image provider key is configured/);
});

test("Edit is the floor: plan and readonly block it before any request, edit and execute allow it", async () => {
  for (const tier of ["plan", "readonly"]) {
    const ctx = makeCtx({ autonomy: tier });
    const out = await run(ctx, { prompt: "x" });
    assert.strictEqual(out.status, "BLOCKED", tier);
    assert.match(out.text, tier === "plan" ? /Plan mode is read-only/ : /read-only autonomy blocks writes\. Ask the user to switch to Edit/);
    assert.strictEqual(ctx.fetch.calls.length, 0, `${tier} must not spend`);
    assert.strictEqual(ctx.approvalsSeen.length, 0, `${tier} refuses before asking`);
  }
  for (const tier of ["edit", "execute"]) {
    const ctx = makeCtx({ autonomy: tier });
    assert.strictEqual((await run(ctx, { prompt: "x" })).status, "SUCCESS", tier);
  }
});

test("every call asks first: the default mode and strict both ask, a denial sends nothing, only approvals off runs unasked, and a build that cannot ask is blocked", async () => {
  for (const approvals of ["high-risk", "strict"]) {
    const no = makeCtx({ approvals }, { approve: false });
    const out = await run(no, { prompt: "a plain prompt", filename: "poster" });
    assert.strictEqual(out.status, "BLOCKED", approvals);
    assert.match(out.text, /DENIED/);
    assert.strictEqual(no.approvalsSeen.length, 1, approvals);
    const req = no.approvalsSeen[0];
    assert.strictEqual(req.kind, "generate_image");
    assert.strictEqual(req.risk, "review");
    assert.strictEqual(req.why, "sends a prompt to OpenAI, off this machine and billed to the user's key");
    assert.strictEqual(req.detail, "OpenAI gpt-image-1, 1024x1024, file assets/generated/poster: a plain prompt");
    assert.strictEqual(no.fetch.calls.length, 0, "a denied call must not spend");
    assert.ok(!fs.existsSync(generatedDir(no)), "a denied call leaves no directory behind");
    assert.ok(no.journalEvents.some((e) => e.event_type === "APPROVAL_REQUESTED"));
    assert.ok(no.journalEvents.some((e) => e.event_type === "APPROVAL_DENIED"));
    const yes = makeCtx({ approvals }, { approve: true });
    assert.strictEqual((await run(yes, { prompt: "a plain prompt" })).status, "SUCCESS", approvals);
    assert.strictEqual(yes.approvalsSeen.length, 1);
    assert.ok(yes.journalEvents.some((e) => e.event_type === "APPROVAL_GRANTED"));
  }
  const off = makeCtx({ approvals: "off" }, { approve: false });
  assert.strictEqual((await run(off, { prompt: "a plain prompt" })).status, "SUCCESS");
  assert.strictEqual(off.approvalsSeen.length, 0);
  assert.ok(off.journalEvents.some((e) => e.event_type === "APPROVAL_SKIPPED" && /approvals off/.test(e.output_summary)));
  const mute = makeCtx({}, { approve: null });
  const out = await run(mute, { prompt: "a plain prompt" });
  assert.strictEqual(out.status, "BLOCKED");
  assert.match(out.text, /no way to ask for it/);
  assert.strictEqual(mute.fetch.calls.length, 0);
  assert.ok(!fs.existsSync(generatedDir(mute)));
});

test("a prompt that carries a credential is Strict, the card names the kind, and the value is cut from the card and the journal", async () => {
  const leaky = makeCtx({}, { approve: false });
  const out = await run(leaky, { prompt: "put this on a poster: AKIAIOSFODNN7EXAMPLE", filename: "poster" });
  assert.strictEqual(out.status, "BLOCKED");
  const req = leaky.approvalsSeen[0];
  assert.strictEqual(req.risk, "strict");
  assert.strictEqual(req.why, "sends what looks like an AWS access key id to OpenAI, billed to the user's key");
  assert.strictEqual(req.detail, "OpenAI gpt-image-1, 1024x1024, file assets/generated/poster: put this on a poster: [an AWS access key id]");
  assert.ok(!everything(leaky, out).includes("AKIAIOSFODNN7EXAMPLE"));
  assert.strictEqual(leaky.fetch.calls.length, 0);
  assert.ok(!fs.existsSync(generatedDir(leaky)), "a denied call leaves no directory behind");
  // The card is cut to 600 characters after redaction, so a key that straddles
  // the cut cannot leave a fragment of itself on the card.
  const edge = makeCtx({}, { approve: false });
  await run(edge, { prompt: "x".repeat(592) + " AKIAIOSFODNN7EXAMPLE and more", filename: "edge" });
  assert.ok(!edge.approvalsSeen[0].detail.includes("AKIA"), edge.approvalsSeen[0].detail.slice(-40));
  // redactSecrets itself: the kind stays, the value goes, a key block goes header to footer.
  assert.strictEqual(H.redactSecrets("key sk-ant-abcdefghijklmnopqrstuvwxyz here"), "key [an Anthropic API key] here");
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE\nabc\n-----END RSA PRIVATE KEY-----";
  assert.strictEqual(H.redactSecrets(`before ${pem} after`), "before [a private key block] after");
  assert.strictEqual(H.redactSecrets("nothing here"), "nothing here");
});

test("OpenRouter is used when there is no OpenAI key, at its own endpoint, and the provider's cost figure is reported", async () => {
  const ctx = makeCtx({}, {
    imageCredential: ROUTER,
    fetch: stubFetch({ body: { data: [{ b64_json: PNG_1x1, media_type: "image/png" }], usage: { cost: 0.04 } } }),
  });
  const out = await run(ctx, { prompt: "a hex tile", size: "1536x1024" });
  assert.strictEqual(out.status, "SUCCESS");
  assert.strictEqual(ctx.fetch.calls[0].url, "https://openrouter.ai/api/v1/images");
  const body = JSON.parse(ctx.fetch.calls[0].init.body);
  assert.deepStrictEqual(body, { model: "google/gemini-2.5-flash-image", prompt: "a hex tile", n: 1, size: "1536x1024", output_format: "png" });
  assert.match(out.text, /OpenRouter google\/gemini-2\.5-flash-image, \$0\.0400 billed by the provider, not in the turn meter/);
  assert.match(ctx.approvalsSeen[0].why, /to OpenRouter, off this machine/);
  assert.ok(!everything(ctx, out).includes(SECRET));
});

test("imageModel in config: overrides the default, a malformed or other-provider id falls back, DALL-E gets its own sizes and response_format", async () => {
  const d3 = makeCtx({ imageModel: "dall-e-3" });
  const out = await run(d3, { prompt: "x", size: "1536x1024" });
  assert.deepStrictEqual(JSON.parse(d3.fetch.calls[0].init.body), { model: "dall-e-3", prompt: "x", n: 1, size: "1792x1024", response_format: "b64_json" });
  assert.match(out.text, /OpenAI dall-e-3/);
  assert.match(d3.approvalsSeen[0].detail, /^OpenAI dall-e-3, 1792x1024, /, "the card shows the size that will be sent");
  const d2 = makeCtx({ imageModel: "dall-e-2" });
  assert.strictEqual((await run(d2, { prompt: "x", size: "1024x1536" })).text, "rejected: dall-e-2 accepts 1024x1024 only. No request was sent.");
  assert.strictEqual(d2.fetch.calls.length, 0);
  assert.strictEqual(d2.approvalsSeen.length, 0, "refused before asking");
  await run(d2, { prompt: "x" });
  assert.strictEqual(JSON.parse(d2.fetch.calls[0].init.body).size, "1024x1024");
  const bad = makeCtx({ imageModel: "not a model id!" });
  await run(bad, { prompt: "x" });
  assert.strictEqual(JSON.parse(bad.fetch.calls[0].init.body).model, "gpt-image-1");
  // An OpenAI id is bare and an OpenRouter id is vendor/model. The wrong shape
  // for the selected provider could only 400, so it falls back to the default.
  const slugOnOpenai = makeCtx({ imageModel: "openai/gpt-image-1" });
  await run(slugOnOpenai, { prompt: "x" });
  assert.strictEqual(JSON.parse(slugOnOpenai.fetch.calls[0].init.body).model, "gpt-image-1");
  const bareOnRouter = makeCtx({ imageModel: "gpt-image-1" }, { imageCredential: ROUTER });
  await run(bareOnRouter, { prompt: "x" });
  assert.strictEqual(JSON.parse(bareOnRouter.fetch.calls[0].init.body).model, "google/gemini-2.5-flash-image");
  const slugOnRouter = makeCtx({ imageModel: "openai/gpt-image-1" }, { imageCredential: ROUTER });
  await run(slugOnRouter, { prompt: "x" });
  assert.deepStrictEqual(JSON.parse(slugOnRouter.fetch.calls[0].init.body), { model: "openai/gpt-image-1", prompt: "x", n: 1, size: "1024x1024", output_format: "png" });
});

test("filenames are one clean segment, never overwrite, and default to an opaque stamp rather than the prompt", async () => {
  const ctx = makeCtx();
  const a = await run(ctx, { prompt: "escape attempt", filename: "../../outside/evil.PNG" });
  assert.match(a.text, /^generated assets\/generated\/evil\.png /);
  assert.ok(!fs.existsSync(path.join(ctx.dir, "..", "outside")));
  const b = await run(ctx, { prompt: "again", filename: "evil" });
  assert.match(b.text, /^generated assets\/generated\/evil-2\.png /);
  const c = await run(ctx, { prompt: "a secret garden nobody should read in a filename" });
  const name = c.text.split(" ")[1];
  assert.match(name, /^assets\/generated\/img-[a-z0-9]+-[0-9a-f]{4}\.png$/, name);
  assert.ok(!name.includes("secret"));
});

test("an assets/generated that resolves outside the workspace is refused before any request", async () => {
  const ctx = makeCtx();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-image-outside-"));
  fs.mkdirSync(path.join(ctx.dir, "assets"));
  fs.symlinkSync(outside, path.join(ctx.dir, "assets", "generated"));
  const out = await run(ctx, { prompt: "x" });
  assert.strictEqual(out.status, "BLOCKED");
  assert.match(out.text, /resolves outside the workspace/);
  assert.strictEqual(ctx.fetch.calls.length, 0);
  assert.strictEqual(ctx.approvalsSeen.length, 0);
  assert.deepStrictEqual(fs.readdirSync(outside), []);
});

test("a symlinked assets/ pointing out of the workspace is refused before the directory is made, so nothing appears outside", async () => {
  const ctx = makeCtx();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-image-outside-"));
  fs.symlinkSync(outside, path.join(ctx.dir, "assets"));
  const out = await run(ctx, { prompt: "x" });
  assert.strictEqual(out.status, "BLOCKED");
  assert.match(out.text, /resolves outside the workspace/);
  assert.strictEqual(ctx.fetch.calls.length, 0);
  assert.strictEqual(ctx.approvalsSeen.length, 0, "refused before asking");
  assert.ok(!fs.existsSync(path.join(outside, "generated")), "no generated/ made outside the workspace");
  assert.deepStrictEqual(fs.readdirSync(outside), []);
});

test("bad arguments and bad provider payloads are rejected without writing", async () => {
  const ctx = makeCtx();
  assert.strictEqual((await run(ctx, {})).text, "rejected: prompt is required");
  assert.match((await run(ctx, { prompt: "x", size: "9000x9000" })).text, /^rejected: size must be one of/);
  const empty = makeCtx({}, { fetch: stubFetch({ body: { data: [] } }) });
  assert.strictEqual((await run(empty, { prompt: "x" })).text, "error: OpenAI returned no image data. No file was written.");
  const junk = makeCtx({}, { fetch: stubFetch({ body: { data: [{ b64_json: Buffer.from("not an image at all, just text bytes").toString("base64") }] } }) });
  assert.match((await run(junk, { prompt: "x" })).text, /not a PNG, JPEG, or WebP image/);
  assert.strictEqual(ctx.fetch.calls.length, 0);
  assert.strictEqual(ctx.approvalsSeen.length, 0, "bad arguments are refused before asking");
});

test("a saved image is a mutation that the change list, the rollback list, a rejection, and the receipt all name by file", async () => {
  const ctx = makeCtx();
  const st = state(ctx);
  await H.callTool(ctx, "generate_image", { prompt: "x", filename: "one" }, {}, st);
  await H.callTool(ctx, "generate_image", { prompt: "y", filename: "one" }, {}, st);
  assert.strictEqual(st.mutated, true);
  assert.deepStrictEqual(st.mutations, ["generate_image assets/generated/one.png", "generate_image assets/generated/one-2.png"]);
  assert.deepStrictEqual(st.rollback.map((r) => r.path), ["assets/generated/one.png", "assets/generated/one-2.png"]);
  assert.strictEqual(st.rollback[0].before, "(absent before this turn; delete the file to undo)");
  assert.match(H.rejectionPrompt({ summary: "wrong picture" }, st.rollback), /^- assets\/generated\/one\.png -> \(absent before this turn; delete the file to undo\)$/m);
  assert.match(H.verdictReceipt({ status: "fail", summary: "wrong picture", checks: [] }, st.rollback), /- assets\/generated\/one-2\.png -> \(absent before this turn/);
  const out = await H.execTool(ctx, "generate_image", { prompt: "x" }, { verify: true }, st);
  assert.match(out, /^blocked: the verifier does not change anything/);
});

test("end to end through runAgent: the tool_result event carries the path and not the key", async () => {
  const ctx = makeCtx();
  const events = [];
  let n = 0;
  const deps = {
    gatewayChat: async () => n++ === 0
      ? { content: "", tool_calls: [{ id: "c1", function: { name: "generate_image", arguments: JSON.stringify({ prompt: "a logo", filename: "logo" }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
      : { content: "Saved to assets/generated/logo.png", tool_calls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    send: (ev) => events.push(ev), isAborted: () => false, setController: () => {},
  };
  const result = await H.runAgent(ctx, [{ role: "user", content: "make a logo" }], deps);
  const tr = events.find((e) => e.type === "tool_result");
  assert.ok(tr && tr.name === "generate_image");
  assert.match(tr.result, /^generated assets\/generated\/logo\.png /);
  assert.strictEqual(ctx.approvalsSeen.length, 1, "asked once on the way");
  assert.deepStrictEqual(result.mutations, ["generate_image assets/generated/logo.png"]);
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(fs.existsSync(path.join(ctx.dir, "assets", "generated", "logo.png")));
});

test("a prompt over the limit is refused before asking or sending, never cut, and the limit is the model's where that is lower", async () => {
  const ctx = makeCtx();
  const long = await run(ctx, { prompt: "x".repeat(4001) });
  assert.strictEqual(long.text, "rejected: the prompt is 4001 characters and gpt-image-1 takes 4000 at most. Shorten it. No request was sent.");
  assert.strictEqual(ctx.fetch.calls.length, 0);
  assert.strictEqual(ctx.approvalsSeen.length, 0, "refused before the user is asked");
  assert.ok(nothingSaved(ctx));
  // At the limit the whole prompt goes, none of it cut.
  const full = await run(ctx, { prompt: "y".repeat(4000) });
  assert.strictEqual(full.status, "SUCCESS");
  assert.strictEqual(JSON.parse(ctx.fetch.calls[0].init.body).prompt.length, 4000);
  const d2 = makeCtx({ imageModel: "dall-e-2" });
  assert.strictEqual((await run(d2, { prompt: "z".repeat(1001) })).text, "rejected: the prompt is 1001 characters and dall-e-2 takes 1000 at most. Shorten it. No request was sent.");
  assert.strictEqual(d2.fetch.calls.length, 0);
  // The card shows the first 600 characters and says that is what it shows.
  const card = makeCtx({}, { approve: false });
  await run(card, { prompt: "w".repeat(700) });
  assert.ok(card.approvalsSeen[0].detail.endsWith(`${"w".repeat(600)} [first 600 of 700 characters]`), card.approvalsSeen[0].detail.slice(-60));
  const short = makeCtx({}, { approve: false });
  await run(short, { prompt: "v".repeat(600) });
  assert.ok(short.approvalsSeen[0].detail.endsWith("v".repeat(600)), "a prompt that fits is shown whole, with no note");
});

test("the tool card gets the prompt with a credential's value cut, the provider gets it as the user approved it, and the result line does not echo it", async () => {
  const ctx = makeCtx();
  const events = [];
  let n = 0;
  const deps = {
    gatewayChat: async () => n++ === 0
      ? { content: "", tool_calls: [{ id: "c1", function: { name: "generate_image", arguments: JSON.stringify({ prompt: "put this on a poster: AKIAIOSFODNN7EXAMPLE", filename: "poster" }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
      : { content: "done", tool_calls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    send: (ev) => events.push(ev), isAborted: () => false, setController: () => {},
  };
  await H.runAgent(ctx, [{ role: "user", content: "make a poster" }], deps);
  const call = events.find((e) => e.type === "tool_call");
  assert.strictEqual(call.args.prompt, "put this on a poster: [an AWS access key id]");
  assert.strictEqual(call.args.filename, "poster", "the other arguments pass through untouched");
  assert.strictEqual(ctx.approvalsSeen.length, 1);
  assert.strictEqual(ctx.approvalsSeen[0].risk, "strict");
  assert.strictEqual(JSON.parse(ctx.fetch.calls[0].init.body).prompt, "put this on a poster: AKIAIOSFODNN7EXAMPLE", "the user said yes to sending it, so it is sent as written");
  const result = events.find((e) => e.type === "tool_result");
  assert.match(result.result, /^generated assets\/generated\/poster\.png .*\nput this on a poster: \[an AWS access key id\]$/s);
  assert.ok(!JSON.stringify(events.filter((e) => e.type === "tool_call" || e.type === "tool_result")).includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(fs.existsSync(path.join(ctx.dir, "assets", "generated", "poster.png")));
});

test("a response over the body cap stops the download instead of buffering it, and the image size is checked on the decoded bytes", async () => {
  // A provider that streams a megabyte a pull and never stops. The reader gives
  // up at the cap, so the pulls stop there rather than running to the end.
  let pulls = 0;
  const endless = makeCtx({}, { fetch: async () => ({ ok: true, status: 200, body: new ReadableStream({ pull(c) { pulls += 1; if (pulls > 400) c.close(); else c.enqueue(new Uint8Array(1 << 20)); } }) }) });
  const out = await run(endless, { prompt: "x" });
  // 32 MiB of image is 42.67 MiB of base64, plus the megabyte allowed for the JSON around it.
  assert.strictEqual(out.text, "error: OpenAI sent more than 43 MB, so the download was stopped. No file was written.");
  assert.ok(pulls < 60, `stopped after ${pulls} pulls`);
  assert.ok(nothingSaved(endless));
  // Just over 32 MB once decoded, while its base64 fits under the body cap: the
  // old check on the string's length let this through.
  const big = makeCtx({}, { fetch: stubFetch({ body: { data: [{ b64_json: Buffer.alloc(32 * 1024 * 1024 + 1, 0x89).toString("base64") }] } }) });
  const out2 = await run(big, { prompt: "x" });
  assert.strictEqual(out2.text, "error: the image from OpenAI is over 32 MB and was not saved.");
  assert.ok(nothingSaved(big));
});

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
      console.error(String((f.e && f.e.stack) || f.e).split("\n").slice(0, 12).join("\n"));
    }
    console.error(`\n${passed} passed, ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`generate-image: ${passed} tests passed`);
})();
