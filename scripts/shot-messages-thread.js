#!/usr/bin/env node
/* Eyes on the thread as texts. Boots the real app on an isolated profile
   against a stubbed gateway, drives a one-worker conversation, a group, and
   the New message list the way the founder would, and photographs each state
   in both palettes: bubbles and runs, the typing bubble while a seat works,
   Delivered and Read under the last text, sender names only in a group.
     CROWE_ALLOW_PLAINTEXT_AUTH=1 npx electron scripts/shot-messages-thread.js
   Prints the screenshot paths and a few facts read back from the DOM so the
   pictures can be believed. Exit 1 if a fact is wrong. Nothing here is a unit
   test; scripts/test-messages.js holds the rules, this shows them. */
const { app, BrowserWindow, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-shot-thread-profile-"));
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-shot-thread-workspace-"));
const OUT = process.env.CROWE_SHOT_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "crowe-thread-shots-"));
fs.mkdirSync(OUT, { recursive: true });
app.setPath("userData", PROFILE);
app.setPath("sessionData", PROFILE);
fs.writeFileSync(path.join(PROFILE, "config.json"), JSON.stringify({ cwd: WORKSPACE, telemetry: false, onboarded: true, autonomy: "edit" }), { mode: 0o600 });
fs.writeFileSync(path.join(WORKSPACE, "README.md"), "# scratch\n");
function writeTestSession() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({ email: "thread-shot@example.com", crowe_tier: "pro", tier: "pro", exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
  const store = JSON.stringify({ token, refreshToken: "" });
  const file = path.join(PROFILE, "auth.bin");
  if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(file, safeStorage.encryptString(store), { mode: 0o600 });
  else if (process.env.CROWE_ALLOW_PLAINTEXT_AUTH === "1" && !app.isPackaged) fs.writeFileSync(file, store, { mode: 0o600 });
  else throw new Error("no credential encryption here and CROWE_ALLOW_PLAINTEXT_AUTH is not set");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* The stub seat. Quick answers to the morning questions; a slow one, with a
   progress line first, to the footage request, so the typing bubble and the
   Read state have time to be photographed. */
const calls = [];
global.fetch = async (url, init = {}) => {
  const u = String(url);
  let payload = {}; try { payload = JSON.parse(init.body || "{}"); } catch {}
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (u.includes("/api/gateway/catalog")) return json({ models: [] });
  if (!u.includes("/api/gateway/chat")) return json({});
  calls.push(payload);
  const usage = { prompt_tokens: 140, completion_tokens: 40 };
  const hasTool = (payload.messages || []).some((m) => m && m.role === "tool");
  const lastUser = String(([...(payload.messages || [])].reverse().find((m) => m && m.role === "user") || {}).content || "");
  const sys = String(((payload.messages || [])[0] || {}).content || "");
  if (/footage/i.test(lastUser) && !hasTool) {
    await sleep(1800);
    return json({ content: "Pulling Tuesday's grow room clips and checking which ones already carry the voice track.",
      tool_calls: [{ id: "c1", type: "function", function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) } }], usage });
  }
  if (/footage/i.test(lastUser) && hasTool) {
    await sleep(2600);
    return json({ content: "Three usable clips: the flush close-up, the harvest pass and the misting shot. The misting one is the strongest opener. I can cut a 40 second version tonight if you want it for the morning post.", usage });
  }
  if (/overnight/i.test(lastUser)) return json({ content: "Quiet night. 412 new subscribers, 61k views, most of it the Start Here film. Revenue holds at $9.80 for the day, all from the long-form.", usage });
  if (/queue/i.test(lastUser)) return json({ content: "Empty. Nothing scheduled and nothing posted since the voiced Short on Sunday.", usage });
  if (/Three Levels/i.test(lastUser)) {
    if (/Studio Director/.test(sys)) return json({ content: "The cut is final: 71.8 seconds, real 4K footage, the voice track at 192k. Thumbnail is the only open item.", usage });
    return json({ content: "The upload slot at 9 is clear and the description and pinned comment are drafted. Say the word and it goes.", usage });
  }
  return json({ content: "Noted.", usage });
};
require(path.join(__dirname, "..", "main.js"));
app.whenReady().then(async () => {
  try {
    await sleep(600);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("no window");
    win.setContentSize(1440, 900);
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
    await sleep(1200);
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { const img = await win.webContents.capturePage(); const p = path.join(OUT, name + ".png"); fs.writeFileSync(p, img.toPNG()); console.log("shot:", p); };
    const facts = [];
    const check = (ok, what) => { facts.push((ok ? "ok   " : "FAIL ") + what); if (!ok) process.exitCode = 1; };
    writeTestSession();
    const cfg = await js(`window.crowe.getConfig()`);
    if (!cfg || !cfg.hasToken) throw new Error("main.js does not see the test session");
    // Show the Messages rail.
    await js(`window.R = () => [...document.querySelectorAll(".room")].at(-1); true`);
    // Bring the newest room panel to the front of the dock before each picture, and say what the dock is showing.
    await js(`window.SHOW = () => { const p = [...panels].reverse().find((x) => x.type === "room"); if (p) { hideLegacy(); focusPanel(p.id); } return { deck: panelDeck.style.display, legacy: (document.querySelector(".legacy-pane-view.active") || {}).id || "", active: activePanelId, roomOnScreen: !!(R() && R().getBoundingClientRect().width > 100) }; }; true`);
    await js(`(function(){ const d=document.getElementById("rooms-drawer"); if(d) d.classList.remove("hidden"); const s=document.getElementById("sessions-drawer"); if(s) s.classList.add("hidden"); })()`);

    // ── one worker ──
    const made = await js(`window.crowe.rooms.create({ title: "", agentIds: ["operator"], brief: "Run Southwest Mushrooms channel operations." })`);
    if (!made || !made.room) throw new Error("create failed: " + JSON.stringify(made));
    const id = made.room.id;
    await js(`openRoomPanel(${JSON.stringify(id)}, "").then((p) => { focusPanel(p.id); return true; })`);
    await sleep(700);
    await js(`window.crowe.rooms.say(${JSON.stringify(id)}, "Morning. What did the channel do overnight?")`);
    await sleep(400);
    await js(`window.crowe.rooms.say(${JSON.stringify(id)}, "And the Shorts queue?")`);
    await sleep(900);
    await js(`R().querySelector('.room-input').value = ''; true`);
    console.log("dock:", JSON.stringify(await js(`SHOW()`))); await sleep(300);
    await shot("01-solo-thread");
    const solo = await js(`(function(){
      const rows=[...R().querySelectorAll('.room-thread .rmsg')];
      return { n: rows.length, ops: rows.filter(r=>r.classList.contains('from-operator')).length,
        heads: rows.filter(r=>getComputedStyle(r.querySelector('.rmsg-head')).display!=='none').length,
        status: (R().querySelector('.rmsg-status')||{}).textContent||'', solo: R().classList.contains('is-solo'),
        marksVisible: rows.filter(r=>r.querySelector(':scope > .rmsg-mark') && getComputedStyle(r.querySelector(':scope > .rmsg-mark')).visibility==='visible').length,
        title: R().querySelector('.room-name').textContent, placeholder: R().querySelector('.room-input').placeholder };
    })()`);
    console.log("solo:", JSON.stringify(solo));
    check(solo.ops === 2 && solo.n === 4, `four bubbles, two yours (${solo.n}/${solo.ops})`);
    check(solo.heads === 0, `no sender names in a one-worker thread (${solo.heads} shown)`);
    check(/^Read/.test(solo.status), `your last text reads Read once the seat answered (${JSON.stringify(solo.status)})`);
    check(solo.marksVisible === 2, `one mark per worker run, by its last bubble (${solo.marksVisible})`);
    check(solo.title === "Operator" && solo.placeholder === "Message Operator", `the worker is called Operator (${solo.title} / ${solo.placeholder})`);

    // ── typing, then Read with a time ──
    // Through the composer this time, the way a person sends: the text must be in the thread before the answer is.
    await js(`(function(){ const i=R().querySelector('.room-input'); i.value = "Can you pull Tuesday's grow room footage for the Shorts cut?"; i.dispatchEvent(new Event('input')); R().querySelector('.room-composer').requestSubmit(); return true; })()`);
    await sleep(1100);
    const sent = await js(`(function(){ const rows=[...R().querySelectorAll('.room-thread .rmsg.from-operator')]; return { n: rows.length, last: rows.length ? rows[rows.length-1].querySelector('.rmsg-body').textContent : '' }; })()`);
    console.log("sent:", JSON.stringify(sent));
    check(sent.n === 3 && /footage/.test(sent.last), `your text is in the thread before the answer (${sent.n} yours, last ${JSON.stringify(sent.last.slice(0, 30))})`);
    const typing = await js(`(function(){ const t=R().querySelector('.rmsg-typing'); return { typing: !!t, label: t ? t.getAttribute('aria-label') : '', status: (R().querySelector('.rmsg-status')||{}).textContent||'', last: R().querySelector('.room-thread').lastElementChild.className }; })()`);
    console.log("typing:", JSON.stringify(typing));
    check(typing.typing && typing.label === "Operator is typing", `typing bubble while the seat works (${JSON.stringify(typing.label)})`);
    check(typing.status === "Read", `a seat at work has read the text (${JSON.stringify(typing.status)})`);
    check(/rmsg-typing/.test(typing.last), "the typing bubble is the last thing in the thread");
    await js(`SHOW()`); await sleep(200);
    await shot("02-typing");
    await sleep(2400);
    const mid = await js(`(function(){ const rows=[...R().querySelectorAll('.room-thread .rmsg')]; return { progress: rows.filter(r=>r.classList.contains('is-progress')).length, typing: !!R().querySelector('.rmsg-typing') }; })()`);
    console.log("mid-turn:", JSON.stringify(mid));
    await sleep(3200);
    const done = await js(`(function(){ const rows=[...R().querySelectorAll('.room-thread .rmsg')]; const st=R().querySelector('.rmsg-status'); return { n: rows.length, typing: !!R().querySelector('.rmsg-typing'), status: st ? st.textContent : '', statusAfterOp: st ? st.previousElementSibling.classList.contains('from-operator') : false, runLast: rows.filter(r=>r.classList.contains('run-last')).length, runFirst: rows.filter(r=>r.classList.contains('run-first')).length }; })()`);
    console.log("done:", JSON.stringify(done));
    check(!done.typing, "the typing bubble leaves when the answer lands");
    check(/^Read \d/.test(done.status) && done.statusAfterOp, `Read carries the time and sits under your last text (${JSON.stringify(done.status)})`);
    await js(`SHOW()`); await sleep(200);
    await shot("03-solo-answered");
    // React to the last worker bubble: the bar's word becomes a chip on the bubble, gold because it is yours.
    await js(`(function(){ const rows=[...R().querySelectorAll('.room-thread .rmsg:not(.from-operator):not(.is-progress)')]; const b=rows[rows.length-1].querySelector('.rmsg-react-btn[data-kind="good"]'); b.click(); return true; })()`);
    await sleep(700);
    const reacted = await js(`(function(){ const chips=[...R().querySelectorAll('.rmsg-chip')]; return { n: chips.length, text: chips.map(c=>c.textContent.trim()), mine: chips.filter(c=>c.classList.contains('mine')).length, onLast: !!R().querySelectorAll('.room-thread .rmsg:not(.from-operator):not(.is-progress)')[R().querySelectorAll('.room-thread .rmsg:not(.from-operator):not(.is-progress)').length-1].querySelector('.rmsg-chip') }; })()`);
    console.log("reacted:", JSON.stringify(reacted));
    check(reacted.n === 1 && reacted.text[0] === "Good" && reacted.mine === 1 && reacted.onLast, `Good sits on the last worker bubble as your chip (${JSON.stringify(reacted)})`);
    const stored = (await js(`window.crowe.rooms.load(${JSON.stringify(id)})`)).messages.filter((m) => m.reactions).map((m) => m.reactions.map((r) => r.by + ":" + r.kind).join(","));
    check(stored.length === 1 && stored[0] === ":operator:good", `the reaction is stored on the message (${JSON.stringify(stored)})`);
    await shot("03b-reaction");
    await js(`document.body.classList.add("dark"); true`);
    await sleep(300);
    await shot("04-solo-dark");
    await js(`document.body.classList.remove("dark"); true`);

    // ── a group: names on the bubbles, two marks ──
    const grp = await js(`window.crowe.rooms.create({ title: "", agentIds: ["operator", "studio"], brief: "The Three Levels Short." })`);
    const gid = grp.room.id;
    await js(`openRoomPanel(${JSON.stringify(gid)}, "").then((p) => { focusPanel(p.id); return true; })`);
    await sleep(700);
    await js(`window.crowe.rooms.say(${JSON.stringify(gid)}, "@room is the Three Levels Short ready to post?")`);
    await sleep(1200);
    const group = await js(`(function(){ const rows=[...R().querySelectorAll('.room-thread .rmsg:not(.from-operator)')]; return { n: rows.length, names: rows.map(r=>r.querySelector('.rmsg-who').textContent), headsShown: rows.filter(r=>getComputedStyle(r.querySelector('.rmsg-head')).display!=='none').length, title: R().querySelector('.room-name').textContent, solo: R().classList.contains('is-solo') }; })()`);
    console.log("group:", JSON.stringify(group));
    check(group.n === 2 && group.headsShown === 2, `two workers answered, each bubble named (${group.n}/${group.headsShown})`);
    check(group.names.includes("Operator") && group.names.includes("Studio Director"), `names without the company in front (${group.names.join(", ")})`);
    check(!group.solo && group.title === "Operator and Studio Director", `a group is titled by its workers (${group.title})`);
    await js(`SHOW()`); await sleep(200);
    await shot("05-group-thread");

    // ── the rail and the New message list ──
    const rail = await js(`[...document.querySelectorAll('#room-list .room-row')].map(r => ({ title: r.querySelector('.room-row-title').textContent, preview: r.querySelector('.room-row-preview').textContent.slice(0, 40), time: r.querySelector('.msg-time').textContent }))`);
    console.log("rail:", JSON.stringify(rail));
    check(rail.length === 2 && rail[0].title === "Operator and Studio Director", "the rail lists the newest conversation first, titled by its workers");
    await js(`document.getElementById("room-new").click(); true`);
    await sleep(800);
    const picker = await js(`(function(){ const c=[...document.querySelectorAll('.msg-contact b')].map(b=>b.textContent); return { n: c.length, first: c.slice(0,4), prefixed: c.filter(n=>/^Crowe\\s/.test(n)) }; })()`);
    console.log("picker:", JSON.stringify(picker));
    check(picker.n >= 15 && picker.prefixed.length === 0, `the contact list names ${picker.n} workers, none prefixed (${picker.prefixed.join(", ") || "none"})`);
    await js(`SHOW()`); await sleep(200);
    await shot("06-new-message");
    await js(`document.body.classList.add("dark"); true`);
    await sleep(300);
    await shot("07-new-message-dark");

    const errors = await js(`window.__consoleErrors || []`);
    console.log("console errors:", JSON.stringify(errors));
    check(!errors.length, "no renderer console errors");
    console.log(facts.join("\n"));
    console.log("calls:", calls.length, "| out:", OUT);
  } catch (e) {
    console.error("shot-messages-thread failed:", e && e.stack || e);
    process.exitCode = 1;
  } finally {
    try { require(path.join(__dirname, "..", "main.js")).shutdownNativeResources(); } catch {}
    setTimeout(() => app.exit(process.exitCode || 0), 300);
  }
});
