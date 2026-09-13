// Screenshots of the Repositories sidebar and lanes, taken the way
// scripts/smoke-shot.js boots the app: an isolated profile, no credentials, a
// Chat and Projects install, a 1280x720 content area. The workspace is two
// scratch git repositories made here - one with a GitHub remote and a dirty
// tree, one clean on a feature branch - and no GitHub token, so the GitHub
// side shows its empty state.
//
//   npx electron scripts/shoot-repositories.js
//
// Writes PNGs to docs/screenshots/repositories/ and downsamples each to 1280
// wide with sips where sips exists (macOS). Dev-only: scripts/ is outside
// build.files.
process.env.CROWE_SPACES = process.env.CROWE_SPACES || "chat,projects";

const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const OUT = path.join(__dirname, "..", "docs", "screenshots", "repositories");
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-repos-profile-"));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-repos-workspace-"));
app.setPath("userData", PROFILE);
app.setPath("sessionData", PROFILE);

// Two checkouts, made without any global git identity: identity and remote are
// per-command, so the machine's own config never leaks into the frame.
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Crowe Logic", "-c", "user.email=desktop@crowelogic.com", ...args], { cwd, stdio: "pipe" });
function makeRepo(name, { remote, branch, dirty }) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.1.0" }, null, 2) + "\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Initial import");
  if (branch) git(dir, "checkout", "-q", "-b", branch);
  if (remote) git(dir, "remote", "add", "origin", remote);
  if (dirty) {
    fs.appendFileSync(path.join(dir, "README.md"), "\nHow the sidebar lists a checkout.\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), "untracked\n");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.1.1" }, null, 2) + "\n");
  }
  return dir;
}
const repoA = makeRepo("crowe-example", { remote: "https://github.com/crowe-logic/crowe-example.git", dirty: true });
const repoB = makeRepo("field-notes", { remote: "git@github.com:crowe-logic/field-notes.git", branch: "notes/2026-09" });

fs.writeFileSync(path.join(PROFILE, "config.json"), JSON.stringify({
  cwd: repoA, telemetry: false, onboarded: true, autonomy: "readonly",
  recentWorkspaces: [{ path: repoA, openedAt: Date.now() - 9 * 60e3 }, { path: repoB, openedAt: Date.now() - 26 * 3600e3 }],
}), { mode: 0o600 });

const { shutdownNativeResources } = require(path.join(__dirname, "..", "main.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = [];
async function shoot(win, name) {
  const img = await win.webContents.capturePage();
  const file = path.join(OUT, name + ".png");
  fs.writeFileSync(file, img.toPNG());
  shots.push(file);
  console.log("shot:", path.relative(path.join(__dirname, ".."), file));
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    await sleep(500);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("no window");
    win.setContentSize(1280, 720);
    await new Promise((res) => (win.webContents.isLoading() ? win.webContents.once("did-finish-load", res) : res()));
    await sleep(1800); // fonts, mark, status, catalog
    const js = (code) => win.webContents.executeJavaScript(code);
    // Drive nothing until the renderer's own init has finished: it restores the
    // space and panels last, and a space set before that is set twice.
    for (let i = 0; i < 100 && !(await js(`document.body.classList.contains("booted")`)); i++) await sleep(100);
    await js(`localStorage.removeItem("crowe-workspace-panels"); [...panels].forEach((p) => closePanel(p.id)); document.body.classList.remove("dark");`);

    // The Repositories lane: two local checkouts (one dirty, one on a branch)
    // and the GitHub empty state, with the drawer beside it.
    await js(`projLane = "repos"; setSpace("projects");`); await sleep(1200);
    const lane = await js(`(() => ({
      locals: document.querySelectorAll("#lane-body .repo-section")[0].querySelectorAll(".lane-repo").length,
      github: [...document.querySelectorAll("#lane-body .repo-section")[1].querySelectorAll(".repo-empty span")].map((s) => s.textContent).join("|"),
      drawer: !document.getElementById("repos-drawer").classList.contains("hidden"),
      branch: document.querySelectorAll("#lane-body .repo-section")[0].querySelectorAll(".lane-repo .repo-meta")[1].textContent,
    }))()`);
    if (lane.locals !== 2 || !lane.drawer) {
      const diag = await js(`(async () => ({ space: document.body.dataset.space, drawerClass: document.getElementById("repos-drawer").className,
        recent: await window.crowe.repos.recent(), cfg: (await window.crowe.getConfig()).cwd }))()`);
      console.error("diag:", JSON.stringify(diag, null, 1));
      throw new Error("expected two checkouts and the drawer: " + JSON.stringify(lane));
    }
    if (!/Connect GitHub/.test(lane.github)) throw new Error("expected the GitHub empty state: " + JSON.stringify(lane));
    console.log("lane:", JSON.stringify(lane));
    await shoot(win, "repositories-lane");

    // The Pull requests lane on a workspace whose remote is GitHub, with no token.
    await js(`document.querySelector('#space-nav [data-lane="pulls"]').click();`); await sleep(900);
    const pulls = await js(`(document.querySelector("#lane-body .repo-empty span") || {}).textContent || ""`);
    if (!/Connect GitHub/.test(pulls || "")) throw new Error("expected the token empty state in Pull requests: " + JSON.stringify(pulls));
    await shoot(win, "pull-requests-empty");

    // Projects home, where the drawer is the first place the checkouts appear.
    await js(`document.querySelector('#space-nav [data-lane="home"]').click();`); await sleep(900);
    await shoot(win, "projects-home-drawer");

    // The lane again on the dark console.
    await js(`document.body.classList.add("dark"); document.querySelector('#space-nav [data-lane="repos"]').click();`); await sleep(1000);
    await shoot(win, "repositories-lane-dark");
    await js(`document.body.classList.remove("dark");`);

    if (process.platform === "darwin") {
      for (const file of shots) { try { execFileSync("sips", ["--resampleWidth", "1280", file], { stdio: "pipe" }); } catch { /* keep the full-size frame */ } }
    }
    console.log("SHOTS-DONE");
  } catch (error) {
    code = 1;
    console.error("SHOTS-FAIL:", error && error.stack ? error.stack : error);
  }
  shutdownNativeResources();
  await sleep(250);
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  app.exit(code);
});
