// Dev-only smoke: boot the real app, flip through the four spaces, capture
// screenshots to /tmp/crowe-shots. Not packaged (scripts/ is outside build.files).
// Run: npx electron scripts/smoke-shot.js
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const OUT = "/tmp/crowe-shots";

const { shutdownNativeResources } = require(path.join(__dirname, "..", "main.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shoot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name + ".png"), img.toPNG());
  console.log("shot:", name);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    await sleep(500);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("no window");
    win.setContentSize(1280, 840);
    await new Promise((res) => (win.webContents.isLoading() ? win.webContents.once("did-finish-load", res) : res()));
    await sleep(1800); // fonts, mark, auth/status, catalog
    const js = (code) => win.webContents.executeJavaScript(code);
    const metrics = () => js(`(() => ({
      panels: document.querySelectorAll(".workspace-panel").length,
      terminals: document.querySelectorAll(".terminal-host").length,
      browsers: document.querySelectorAll(".browser-host webview").length,
      operators: document.querySelectorAll(".operator-grid").length,
      workflows: document.querySelectorAll(".workflow-surface").length,
      agentFleets: document.querySelectorAll(".agent-fleet").length,
      workbenches: document.querySelectorAll(".agent-workbench").length,
      browserControls: [".back",".forward",".reload",".hist",".bookmark",".bookmarks",".browser-url"].every((s) => document.querySelector(s)),
      terminalControls: [".term-restart",".term-clear",".term-copy",".term-export"].every((s) => document.querySelector(s)),
      operatorControls: [".refresh",".stop-agent",".stop-voice",".emergency"].every((s) => document.querySelector(s)),
      persisted: Boolean(localStorage.getItem("crowe-workspace-panels")),
      layout: document.getElementById("panel-deck").className,
      voiceButtons: ["voice-input","voice-output"].every((id) => document.getElementById(id)),
      conversationCopy: Boolean(document.getElementById("copy-conversation")),
      glassLauncher: Boolean(document.querySelector("#glass-launcher img")),
      agentLauncherDocked: Boolean(document.querySelector(".dock-bar #glass-launcher")),
      nothingFloatsOverDeck: [...document.querySelectorAll("body > *")].every((el) => getComputedStyle(el).position !== "fixed" || el.id === "hud" || el.hidden || getComputedStyle(el).display === "none"),
      agentPanels: document.querySelectorAll('.workspace-panel[data-id^="agent-"]').length,
      systemTerminals: document.querySelectorAll('.workspace-panel[data-id^="system-"]').length,
      workbenchControls: [".awb-agent",".awb-mode",".awb-context",".awb-prompt",".awb-run",".awb-save",".awb-attach",".awb-cancel",".awb-workflow",".awb-history",".awb-meter"].every((s) => document.querySelector(s)),
      licensingControls: [".fleet-workspace",".fleet-refresh",".fleet-billing",".fleet-license .badge"].every((s) => document.querySelector(s)),
      licensingSettled: document.querySelector(".fleet-license .badge")?.textContent !== "Checking",
      glassAgents: document.querySelectorAll(".glass-agent").length,
      glassArrange: Boolean(document.getElementById("glass-arrange")),
      glassVisible: [...document.querySelectorAll(".glass-agent")].every((el) => { const r=el.getBoundingClientRect(); return r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight; }),
      glassCompact: [...document.querySelectorAll(".glass-agent")].every((el) => el.offsetWidth<=330 && el.offsetHeight<=360),
      shellOverflow: document.getElementById("shell").scrollWidth > document.getElementById("shell").clientWidth,
    }))()`);
    await js(`localStorage.removeItem("crowe-workspace-panels"); [...panels].forEach((p) => closePanel(p.id)); setSpace("chat")`);
    await sleep(300);
    await js(`addPanel("terminal"); addPanel("terminal"); addPanel("browser", {url:"https://example.com"}); addPanel("operator"); addPanel("workflow"); addPanel("agents"); addPanel("workbench")`);
    await sleep(1500);
    const modular = await metrics();
    assert(modular.panels >= 4, `expected at least 4 panels, got ${modular.panels}`);
    assert(modular.terminals >= 2, `expected multiple terminals, got ${modular.terminals}`);
    assert(modular.browsers >= 1, "browser panel missing");
    assert(modular.operators >= 1, "operator panel missing");
    assert(modular.workflows >= 1, "workflow panel missing");
    assert(modular.agentFleets >= 1, "agent fleet panel missing");
    assert(modular.licensingControls && modular.licensingSettled, "customer licensing controls did not initialize");
    assert(modular.workbenches >= 1 && modular.workbenchControls, "agent workbench or its controls missing");
    assert(await js(`document.querySelectorAll(".wf-template").length >= 2 && document.querySelectorAll(".fleet-card").length >= 4`), "workflow templates or licensed agent cards missing");
    assert(modular.browserControls, "browser navigation, history, or bookmark controls missing");
    assert(modular.terminalControls, "terminal management controls missing");
    assert(modular.operatorControls, "operator management controls missing");
    await js(`{const p=panels.find((x)=>x.type==="browser");p.bookmarks=["https://example.com"];savePanelState();document.querySelector(".bookmarks").click()}`);
    assert(await js(`document.querySelectorAll(".browser-history .history-row").length >= 1`), "browser bookmark list missing");
    assert(modular.persisted, "panel state was not persisted");
    assert(modular.voiceButtons, "voice controls missing");
    assert(modular.conversationCopy, "conversation copy control missing");
    assert(modular.glassLauncher, "branded floating Crowe Logic launcher missing");
    await js(`document.getElementById("settings-btn").click()`); await sleep(200);
    assert(await js(`document.querySelectorAll(".key-provider").length >= 4 && document.getElementById("key-vault-state").textContent.length > 0 && [...document.querySelectorAll(".key-provider input")].every(x=>x.type==="password" && x.autocomplete==="new-password")`), "secure key manager missing or exposes unsafe inputs");
    await js(`document.getElementById("cfg-cancel").click()`);
    await js(`addPanel("agent",{title:"Research"}); addPanel("agent",{title:"Builder"}); addPanel("agent",{title:"Analyst"}); addPanel("system")`);
    await sleep(600);
    const agents = await metrics();
    assert(agents.agentLauncherDocked, "agent launcher missing from the dock bar");
    assert(agents.nothingFloatsOverDeck, "a fixed-position element is floating over the workspace deck");
    assert(agents.agentPanels >= 3, "stackable workspace agents missing");
    assert(agents.systemTerminals === 1, "isolated system terminal missing or duplicated");
    assert(await js(`document.querySelectorAll(".workspace-agent-node .agent-command-dock").length >= 3`), "agent command docks missing");
    await shoot(win, "workspace-agents");
    await js(`addUser("Copy test"); messages.push({role:"user",content:"Copy test"}); const b=addAssistant(); renderText(b,"Portable answer"); attachCopyButton(b.closest(".msg"),"Portable answer"); messages.push({role:"assistant",content:"Portable answer"})`);
    const copyMetrics = await js(`(() => ({messageCopies:document.querySelectorAll(".message-copy").length, exportText:conversationMarkdown()}))()`);
    assert(copyMetrics.messageCopies >= 2, "per-message copy controls missing");
    assert(copyMetrics.exportText.includes("## You") && copyMetrics.exportText.includes("## Crowe Logic"), "conversation export format is incomplete");
    assert(!modular.shellOverflow, "workspace overflowed");
    await js(`document.getElementById("panel-layout").value="grid"; document.getElementById("panel-layout").dispatchEvent(new Event("change"))`);
    await sleep(200);
    const grid = await metrics();
    assert(grid.layout.includes("grid"), "grid layout did not apply");
    console.log("modular:", JSON.stringify(grid));
    await shoot(win, "modular-workspace");

    win.setContentSize(1280, 840);
    await js(`setSpace("chat"); fitTerminals()`);
    await sleep(250);
    await shoot(win, "1-chat-light");
    await js(`setSpace("projects")`); await sleep(900); await shoot(win, "2-projects-home");
    await js(`document.querySelector('[data-lane="deployments"]').click()`); await sleep(900); await shoot(win, "3-projects-deployments");
    await js(`document.querySelector('[data-lane="deepwork"]').click()`); await sleep(600); await shoot(win, "4-projects-deepwork");
    await js(`setSpace("studio")`); await sleep(400); await shoot(win, "5-studio");
    await js(`setSpace("cultivation")`); await sleep(400); await shoot(win, "6-cultivation");
    await js(`document.body.classList.add("dark"); setSpace("projects")`); await sleep(900); await shoot(win, "7-projects-home-dark");
    await js(`setSpace("chat"); document.body.classList.remove("dark"); localStorage.setItem("crowe-space","chat")`);
    await sleep(300);
    console.log("SMOKE-DONE");
    await finish(0);
  } catch (error) {
    console.error("SMOKE-FAIL:", error && error.stack ? error.stack : error);
    await finish(1);
  }
});

// app.exit skips the quit events, so run the teardown by hand and give the
// native children a moment to die before the process goes away.
async function finish(code) {
  shutdownNativeResources();
  await sleep(250);
  app.exit(code);
}
