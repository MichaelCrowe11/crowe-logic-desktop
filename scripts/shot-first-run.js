#!/usr/bin/env node
/* Eyes on the first run. Boots the real app on an empty profile, the way a
   fresh install lands: workspace at the home folder, no Crowe ID session, the
   first-run card up. Photographs the card with the picker as step two, the
   hold on the composer when a send is tried, the hold lifted by home on
   purpose, and the welcome chips aimed at a chosen folder.
     npx electron scripts/shot-first-run.js
   Prints the screenshot paths and a few facts read back from the DOM so the
   pictures can be believed. Exit 1 if a fact is wrong. Nothing here is a unit
   test; scripts/test-first-run.js and the two first-run cases in
   scripts/test-panels.js hold the rules, this shows them. */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-shot-first-run-profile-"));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-shot-first-run-"));
const OUT = process.env.CROWE_SHOT_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "crowe-first-run-shots-"));
fs.mkdirSync(OUT, { recursive: true });
app.setPath("userData", PROFILE);
app.setPath("sessionData", PROFILE);
// A fresh install has no cwd, no session and no onboarded flag. Telemetry off
// so the shot sends nothing.
fs.writeFileSync(path.join(PROFILE, "config.json"), JSON.stringify({ telemetry: false }), { mode: 0o600 });
fs.writeFileSync(path.join(PROJECT, "README.md"), "# demo project\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// No network: the catalog and anything else the app asks for on boot come back empty.
global.fetch = async () => new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
require(path.join(__dirname, "..", "main.js"));
app.whenReady().then(async () => {
  try {
    await sleep(600);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("no window");
    win.setContentSize(1280, 800);
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
    await sleep(1800);
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { const img = await win.webContents.capturePage(); const p = path.join(OUT, name + ".png"); fs.writeFileSync(p, img.toPNG()); console.log("shot:", p); };
    const facts = [];
    const check = (ok, what) => { facts.push((ok ? "ok   " : "FAIL ") + what); if (!ok) process.exitCode = 1; };
    const cfg = await js(`window.crowe.getConfig()`);
    check(cfg && cfg.cwd === cfg.homeDir && !cfg.hasToken, `a fresh profile lands at home with no session (${cfg && cfg.cwd})`);

    // The card, with step two as the picker.
    const card = await js(`(function(){
      const b = document.querySelector("#transcript .msg.assistant .body"); if (!b) return null;
      const steps = [...b.querySelectorAll(".onboarding-steps li")];
      return { text: b.textContent, steps: steps.length,
        picker: steps[1] ? [...steps[1].querySelectorAll(".onboarding-folder button")].map((x) => x.textContent) : [],
        row: [...b.querySelectorAll(".onboarding-actions button")].map((x) => x.textContent),
        placeholder: document.getElementById("input").placeholder };
    })()`);
    check(card && card.text.includes(CroweFirstRunCopy().SIGN_IN_COPY), "the card says what the free tier is");
    check(card && !/operator over your CroweLM gateway|Pro access|Cmd\+O/.test(card.text), "no gateway operator, no Pro wall, no Cmd+O");
    check(card && card.steps === 3 && card.picker.join("|") === "Choose a folder|Use my home folder", `step two is the picker (${card && card.picker.join("|")})`);
    check(card && card.row.join("|") === "Sign in with Crowe ID|Explore first", `the action row (${card && card.row.join("|")})`);
    check(card && card.placeholder === "Choose a project folder to start", `the composer says what it is waiting for (${card && card.placeholder})`);
    await shot("01-first-run-card-light");
    await js(`applyTheme(true); true`); await sleep(400);
    await shot("01b-first-run-card-dark");
    await js(`applyTheme(false); true`); await sleep(300);

    // A send while the hold is on: the picker card, no turn, the draft kept.
    await js(`(function(){ const i = document.getElementById("input"); i.value = "Summarize this project and list what is broken"; i.dispatchEvent(new Event("input")); document.getElementById("composer").requestSubmit(); return true; })()`);
    await sleep(700);
    const held = await js(`(function(){
      const c = document.querySelector("#transcript .msg .workspace-prompt");
      return { card: !!c, buttons: c ? [...c.querySelectorAll("button")].map((x) => x.textContent) : [],
        users: document.querySelectorAll("#transcript .msg.user").length, status: document.getElementById("composer-status").textContent,
        draft: document.getElementById("input").value };
    })()`);
    check(held.card && held.users === 0, `a send while held draws the card and starts no turn (users ${held.users})`);
    check(held.status === "Choose a project folder to start" && held.draft.length > 0, `the caption says why and the draft is kept (${held.status})`);
    await shot("02-composer-held-light");
    await js(`applyTheme(true); true`); await sleep(400);
    await shot("02b-composer-held-dark");
    await js(`applyTheme(false); true`); await sleep(300);

    // Home on purpose lifts the hold: the card goes, the caption rests, and the
    // flag is in config, so the next launch does not ask again.
    await js(`(function(){ const b = [...document.querySelectorAll("#transcript .workspace-prompt button")].find((x) => x.textContent === "Use my home folder"); b.click(); return true; })()`);
    await sleep(900);
    const lifted = await js(`(function(){ return { card: !!document.querySelector("#transcript .msg .workspace-prompt"),
      homeBtn: !!document.querySelector("#transcript .onboarding-folder .use-home"), placeholder: document.getElementById("input").placeholder }; })()`);
    const cfg2 = await js(`window.crowe.getConfig()`);
    check(!lifted.card && !lifted.homeBtn && cfg2.useHomeWorkspace === true, "home on purpose: card gone, home button gone, flag saved");
    const openHint = await js(`TIER_HINT[document.body.dataset.tier] || INPUT_PLACEHOLDER`);
    const caption = await js(`document.getElementById("composer-status").textContent`);
    check(lifted.placeholder === openHint, `the composer is open again (${lifted.placeholder})`);
    check(caption === "Ready", `the caption rests (${caption})`);
    await shot("03-hold-lifted-home-light");

    // A project folder, chosen: the welcome's first chip names it, and what it
    // sends is about the workspace, not the name.
    // The same path the sidebar takes: open, then let the renderer read the new workspace.
    await js(`window.crowe.repos.open(${JSON.stringify(PROJECT)}).then(() => afterWorkspaceChange())`);
    await sleep(600);
    await js(`(function(){ [...document.querySelectorAll("#transcript .msg")].forEach((m) => m.remove()); resetWelcome(); return true; })()`);
    await sleep(400);
    const chips = await js(`(function(){ const c = document.querySelector("#transcript .welcome .chips .chip"); return { text: c.textContent, prompt: c.dataset.prompt || "", cwd: document.getElementById("cwd").textContent }; })()`);
    const cfg3 = await js(`window.crowe.getConfig()`);
    check(chips.text === `List the files in ${path.basename(PROJECT)} and summarize the project`, `the first chip names the folder (${chips.text})`);
    check(chips.prompt === "List the files in the current workspace and summarize the project", "and sends a prompt about the workspace");
    check(cfg3.useHomeWorkspace === false, "choosing a project un-chooses home");
    await shot("04-chips-aimed-at-folder-light");

    console.log(facts.join("\n"));
  } catch (e) {
    console.error("shot failed:", e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); fs.rmSync(PROJECT, { recursive: true, force: true }); } catch {}
    app.exit(process.exitCode || 0);
  }
});
function CroweFirstRunCopy() { return require(path.join(__dirname, "..", "renderer", "first-run.js")); }
