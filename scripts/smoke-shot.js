// Dev-only smoke: boot the real app, flip through the four spaces, capture
// screenshots to /tmp/crowe-shots. Not packaged (scripts/ is outside build.files).
// Run: npx electron scripts/smoke-shot.js
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const OUT = "/tmp/crowe-shots";

require(path.join(__dirname, "..", "main.js"));

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
    const metrics = () => js(`(() => {
      const shell = document.getElementById("shell");
      const wb = document.getElementById("workbench");
      const shellRight = shell.getBoundingClientRect().right;
      return {
        shellClientWidth: shell.clientWidth,
        shellScrollWidth: shell.scrollWidth,
        workbenchWidth: wb.getBoundingClientRect().width,
        agentWidth: document.getElementById("agent").getBoundingClientRect().width,
        workspaceWidth: document.getElementById("workspace").getBoundingClientRect().width,
        split: wb.style.getPropertyValue("--split"),
        cols: term ? term.cols : 0,
        overflowers: [...shell.querySelectorAll("*")]
          .filter((el) => el.getBoundingClientRect().right > shellRight + 0.5)
          .slice(0, 8)
          .map((el) => ({ id: el.id, cls: el.className, right: el.getBoundingClientRect().right })),
      };
    })()`);
    const resize = async (width) => { win.setContentSize(width, 840); await sleep(350); };
    const assertContained = (label, value) => assert(
      value.shellScrollWidth === value.shellClientWidth,
      `${label}: #shell overflowed (${value.shellScrollWidth} > ${value.shellClientWidth})`,
    );

    // Chat: start at 1280 with the fluid split, then verify FitAddon reduces
    // terminal columns when the content width shrinks to the 900px minimum.
    await js(`setSpace("chat"); document.getElementById("workbench").style.removeProperty("--split"); fitTerm()`);
    await sleep(200);
    const chatWide = await metrics();
    await resize(900);
    const chatNarrow = await metrics();
    assertContained("chat@900", chatNarrow);
    assert(chatNarrow.cols < chatWide.cols, `chat: terminal cols did not shrink (${chatWide.cols} -> ${chatNarrow.cols})`);
    console.log("resize: chat", chatWide.cols, "->", chatNarrow.cols, "cols");
    await shoot(win, "resize-chat-900");

    // A split dragged at 1280 must be reclamped after shrinking, otherwise its
    // stale pixel width alone can overflow the narrower grid.
    await resize(1280);
    await js(`setWorkbenchSplit(1e6); fitTerm()`);
    await resize(900);
    const staleSplit = await metrics();
    console.log("stale split:", JSON.stringify(staleSplit));
    assertContained("chat stale split@900", staleSplit);
    assert(staleSplit.workspaceWidth >= 319, `stale split: workspace collapsed to ${staleSplit.workspaceWidth}px`);

    // Projects → Deep work adds the 170px space nav. Exercise the same 1280 →
    // 900 transition with a fluid split and require FitAddon to shrink again.
    await resize(1280);
    await js(`document.getElementById("workbench").style.removeProperty("--split"); document.querySelector('[data-space="projects"]').click(); document.querySelector('[data-lane="deepwork"]').click()`);
    await sleep(350);
    const deepWide = await metrics();
    await resize(900);
    const deepNarrow = await metrics();
    assertContained("projects/deepwork@900", deepNarrow);
    assert(deepNarrow.cols < deepWide.cols, `deep work: terminal cols did not shrink (${deepWide.cols} -> ${deepNarrow.cols})`);
    console.log("resize: deep work", deepWide.cols, "->", deepNarrow.cols, "cols");
    await shoot(win, "resize-projects-deepwork-900");

    // Divider extremes retain the intended 300px agent and 320px workspace
    // floors at the app's minimum width, including the 5px divider track.
    await js(`setWorkbenchSplit(-1e6); fitTerm()`); await sleep(100);
    const splitLeft = await metrics();
    assertContained("divider left clamp", splitLeft);
    assert(splitLeft.agentWidth >= 299, `divider left: agent width ${splitLeft.agentWidth}px`);
    await js(`setWorkbenchSplit(1e6); fitTerm()`); await sleep(100);
    const splitRight = await metrics();
    assertContained("divider right clamp", splitRight);
    assert(splitRight.workspaceWidth >= 319, `divider right: workspace width ${splitRight.workspaceWidth}px`);
    console.log("divider:", splitLeft.agentWidth, "px agent /", splitRight.workspaceWidth, "px workspace");

    await resize(1280);
    await js(`document.getElementById("workbench").style.removeProperty("--split"); setSpace("chat"); fitTerm()`);
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
    app.exit(0);
  } catch (error) {
    console.error("SMOKE-FAIL:", error && error.stack ? error.stack : error);
    app.exit(1);
  }
});
