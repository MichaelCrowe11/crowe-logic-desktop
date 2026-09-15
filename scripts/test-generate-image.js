// Headless tests for the generate_image tool. Pure Node, no Electron, no
// network: the provider is a stubbed fetch handed in through ctx.fetch, the
// key comes from a stubbed ctx.imageCredential, and the workspace is a temp
// directory. What is pinned here: the file lands under assets/generated in the
// workspace, the tool sits at the Edit tier and the Review risk class, and the
// key never appears in anything the tool hands back.
//
//   node scripts/test-generate-image.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const H = require("../harness");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const SECRET = "sk-test-KEEP-OUT-OF-OUTPUT-4f9c";
// A 1x1 PNG, the smallest valid one.
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function workspace() { return fs.mkdtempSync(path.join(os.tmpdir(), "crowe-image-")); }
// A fetch stub that records what it was asked and answers with `answer`.
function stubFetch(answer) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    if (answer.throws) throw answer.throws;
    const status = answer.status || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => answer.body };
  };
  f.calls = calls;
  return f;
}
function makeCtx(cfgPatch = {}, hooks = {}) {
  const dir = hooks.dir || workspace();
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
    ...hooks,
  };
  if (hooks.approve !== undefined) ctx.requestApproval = async (req) => { ctx.approvalsSeen.push(req); return { approved: hooks.approve }; };
  return ctx;
}
const state = (ctx) => H.newState(ctx, ctx.loadConfig(), {}, { expert: "operator", model: "m" });
const run = (ctx, args, route = {}) => H.callTool(ctx, "generate_image", args, route, state(ctx));
// Everything the tool let out of the function: result text plus the journal.
const everything = (ctx, out) => out.text + JSON.stringify(ctx.journalEvents) + JSON.stringify(ctx.approvalsSeen);

test("the tool is offered to the operator, not to the verifier, and is classed compensatable", () => {
  const ctx = makeCtx({ autonomy: "execute" });
  assert.ok(H.BUILTIN_TOOLS.some((t) => t.function.name === "generate_image"));
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
  const call = ctx.fetch.calls[0];
  assert.strictEqual(call.url, "https://api.openai.com/v1/images/generations");
  assert.strictEqual(call.init.headers.Authorization, `Bearer ${SECRET}`, "the key rides in the one header");
  assert.strictEqual(call.init.redirect, "error");
  const body = JSON.parse(call.init.body);
  assert.deepStrictEqual(body, { model: "gpt-image-1", prompt: "a spore print on black card", n: 1, size: "1024x1024", output_format: "png" });
});

test("the key appears nowhere in the result, the journal, or the approval request", async () => {
  const ctx = makeCtx({ approvals: "strict" }, { approve: true });
  const out = await run(ctx, { prompt: "a tiny mushroom" });
  assert.strictEqual(out.status, "SUCCESS");
  assert.ok(!everything(ctx, out).includes(SECRET));
  assert.ok(!everything(ctx, out).includes("KEEP-OUT"));
});

test("a provider error body is never quoted, even when it echoes the key", async () => {
  const ctx = makeCtx({}, { fetch: stubFetch({ status: 401, body: { error: { code: "invalid_api_key", message: `Incorrect API key provided: ${SECRET}` } } }) });
  const out = await run(ctx, { prompt: "anything" });
  assert.strictEqual(out.status, "FAIL");
  assert.strictEqual(out.text, "error: OpenAI answered HTTP 401 (invalid_api_key). The key was refused; test it in Settings > Keys. No file was written.");
  assert.ok(!everything(ctx, out).includes(SECRET));
  assert.ok(!fs.existsSync(path.join(ctx.dir, "assets", "generated")) || fs.readdirSync(path.join(ctx.dir, "assets", "generated")).length === 0);
});

test("a network failure names only the error code, and a timeout says the provider may still have billed", async () => {
  const dropped = makeCtx({}, { fetch: stubFetch({ throws: Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), { code: "ECONNREFUSED" }) }) });
  const out = await run(dropped, { prompt: "x" });
  assert.strictEqual(out.text, "error: OpenAI could not be reached (ECONNREFUSED). No file was written.");
  const slow = makeCtx({}, { fetch: stubFetch({ throws: Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }) }) });
  const out2 = await run(slow, { prompt: "x" });
  assert.match(out2.text, /^error: OpenAI did not answer within 120s\. No file was written; the provider may still have billed/);
});

test("no key configured: a plain message naming Settings > Keys, and no request is sent", async () => {
  const ctx = makeCtx({}, { imageCredential: () => null });
  const out = await run(ctx, { prompt: "x" });
  assert.strictEqual(out.text, "No image provider key is configured. Ask the user to add an OpenAI or OpenRouter key in Settings > Keys, then try again.");
  assert.strictEqual(ctx.fetch.calls.length, 0);
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
  }
  for (const tier of ["edit", "execute"]) {
    const ctx = makeCtx({ autonomy: tier });
    assert.strictEqual((await run(ctx, { prompt: "x" })).status, "SUCCESS", tier);
  }
});

test("Review risk: runs unasked in the default approval mode, asks in strict mode, and a denial sends nothing", async () => {
  const dflt = makeCtx({ approvals: "high-risk" }, { approve: false });
  assert.strictEqual((await run(dflt, { prompt: "a plain prompt" })).status, "SUCCESS");
  assert.strictEqual(dflt.approvalsSeen.length, 0);
  const strict = makeCtx({ approvals: "strict" }, { approve: false });
  const out = await run(strict, { prompt: "a plain prompt" });
  assert.strictEqual(out.status, "BLOCKED");
  assert.match(out.text, /DENIED/);
  assert.strictEqual(strict.approvalsSeen.length, 1);
  assert.strictEqual(strict.approvalsSeen[0].kind, "generate_image");
  assert.strictEqual(strict.approvalsSeen[0].risk, "review");
  assert.match(strict.approvalsSeen[0].why, /billed to the user's key/);
  assert.strictEqual(strict.fetch.calls.length, 0, "a denied call must not spend");
});

test("a long or pasted prompt is asked about in every mode; a prompt carrying a credential is Strict", async () => {
  const long = makeCtx({}, { approve: false });
  const out = await run(long, { prompt: "line\n".repeat(5) + "draw this" });
  assert.strictEqual(out.status, "BLOCKED");
  assert.strictEqual(long.approvalsSeen[0].risk, "review");
  assert.match(long.approvalsSeen[0].why, /long or pasted prompt/);
  assert.strictEqual(long.fetch.calls.length, 0);
  const leaky = makeCtx({}, { approve: false });
  const out2 = await run(leaky, { prompt: "put this on a poster: AKIAIOSFODNN7EXAMPLE" });
  assert.strictEqual(out2.status, "BLOCKED");
  assert.strictEqual(leaky.approvalsSeen[0].risk, "strict");
  assert.match(leaky.approvalsSeen[0].why, /sends what looks like .* to OpenAI/);
  assert.strictEqual(leaky.fetch.calls.length, 0);
});

test("OpenRouter is used when there is no OpenAI key, at its own endpoint, and the provider's cost figure is reported", async () => {
  const ctx = makeCtx({}, {
    imageCredential: () => ({ provider: "openrouter", secret: SECRET }),
    fetch: stubFetch({ body: { data: [{ b64_json: PNG_1x1, media_type: "image/png" }], usage: { cost: 0.04 } } }),
  });
  const out = await run(ctx, { prompt: "a hex tile", size: "1536x1024" });
  assert.strictEqual(out.status, "SUCCESS");
  assert.strictEqual(ctx.fetch.calls[0].url, "https://openrouter.ai/api/v1/images");
  const body = JSON.parse(ctx.fetch.calls[0].init.body);
  assert.deepStrictEqual(body, { model: "google/gemini-2.5-flash-image", prompt: "a hex tile", n: 1, size: "1536x1024", output_format: "png" });
  assert.match(out.text, /OpenRouter google\/gemini-2\.5-flash-image, \$0\.0400 billed by the provider, not in the turn meter/);
  assert.ok(!everything(ctx, out).includes(SECRET));
});

test("imageModel in config overrides the default; a malformed id falls back; DALL-E gets response_format instead", async () => {
  const ctx = makeCtx({ imageModel: "dall-e-3" });
  await run(ctx, { prompt: "x" });
  const body = JSON.parse(ctx.fetch.calls[0].init.body);
  assert.strictEqual(body.model, "dall-e-3");
  assert.strictEqual(body.response_format, "b64_json");
  assert.strictEqual(body.output_format, undefined);
  const bad = makeCtx({ imageModel: "not a model id!" });
  await run(bad, { prompt: "x" });
  assert.strictEqual(JSON.parse(bad.fetch.calls[0].init.body).model, "gpt-image-1");
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
  assert.strictEqual(fs.readdirSync(outside).length, 0);
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
});

test("a saved image counts as a mutation, so the change list and the verifier see it, and the verifier itself may not call it", async () => {
  const ctx = makeCtx();
  const st = state(ctx);
  await H.callTool(ctx, "generate_image", { prompt: "x", filename: "one" }, {}, st);
  assert.strictEqual(st.mutated, true);
  assert.deepStrictEqual(st.mutations, ["generate_image assets/generated/"]);
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
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(fs.existsSync(path.join(ctx.dir, "assets", "generated", "logo.png")));
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
