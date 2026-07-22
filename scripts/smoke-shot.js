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
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await sleep(500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.error("no window"); app.exit(1); return; }
  win.setSize(1280, 840);
  await new Promise((res) => (win.webContents.isLoading() ? win.webContents.once("did-finish-load", res) : res()));
  await sleep(1800); // fonts, mark, auth/status, catalog
  const js = (code) => win.webContents.executeJavaScript(code).catch((e) => console.error("js:", String(e).slice(0, 200)));
  await shoot(win, "1-chat-light");
  await js(`setSpace("projects")`); await sleep(900); await shoot(win, "2-projects-home");
  await js(`document.querySelector('[data-lane="deployments"]').click()`); await sleep(900); await shoot(win, "3-projects-deployments");
  await js(`document.querySelector('[data-lane="deepwork"]').click()`); await sleep(600); await shoot(win, "4-projects-deepwork");
  await js(`setSpace("studio")`); await sleep(400); await shoot(win, "5-studio");
  await js(`setSpace("cultivation")`); await sleep(400); await shoot(win, "6-cultivation");
  await js(`document.body.classList.add("dark"); setSpace("projects")`); await sleep(900); await shoot(win, "7-projects-home-dark");
  await js(`setSpace("chat"); document.body.classList.remove("dark"); localStorage.setItem("crowe-space","chat")`);
  await sleep(300);

  // Resize regression: shrinking the window must shrink the terminal so #shell
  // never overflows the viewport (grid items need min-width:0 for this).
  const measure = () => js(`(() => { const s = document.getElementById("shell");
    return { scroll: s.scrollWidth, client: s.clientWidth, cols: typeof term !== "undefined" && term ? term.cols : null }; })()`);
  const wide = await measure();
  win.setContentSize(900, 840);
  await sleep(600);
  const chat900 = await measure();
  await shoot(win, "8-chat-900");
  await js(`setSpace("projects")`); await sleep(400);
  await js(`document.querySelector('[data-lane="deepwork"]').click()`); await sleep(600);
  const deep900 = await measure();
  await shoot(win, "9-deepwork-900");
  await js(`setSpace("chat"); localStorage.setItem("crowe-space","chat")`);
  console.log("resize:", JSON.stringify({ wide, chat900, deep900 }));
  const fits = (m) => m && m.scroll === m.client;
  const shrank = wide && chat900 && wide.cols && chat900.cols && chat900.cols < wide.cols;
  if (!fits(chat900) || !fits(deep900) || !shrank) { console.error("SMOKE-FAIL: shell overflows or term did not shrink after resize"); app.exit(1); return; }
  console.log("SMOKE-DONE");
  app.exit(0);
});
