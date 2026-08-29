// Does a build shipped with a narrower set of spaces actually arrive narrowed?
//
//   CROWE_SPACES=chat,projects electron scripts/test-install-spaces.js   # narrowed
//   electron scripts/test-install-spaces.js                             # ordinary
//
// test-panels.js covers the renderer's half of this by assigning
// window.crowe.installSpaces directly, which is fast and tests the interesting
// logic. What it cannot see is the wire: installSpaces() in main.js reading the
// config, additionalArguments carrying it, and preload.js parsing it back out of
// process.argv. Every one of those could be broken while test-panels stayed
// green, because the shim hands the renderer the answer that main was supposed
// to compute.
//
// So this boots the real app - real main.js, real sandboxed preload, real
// renderer - and reads the rail.
//
// It runs twice, because one direction proves nothing on its own. A preload that
// ignores the flag passes the ordinary case; a preload that hardcodes a narrowed
// list passes the narrowed one. Only both together say the flag is what decides.

const { app, BrowserWindow } = require("electron");
const path = require("path");

const { shutdownNativeResources } = require(path.join(__dirname, "..", "main.js"));

const WANT = (process.env.CROWE_SPACES || "").split(",").map((s) => s.trim()).filter(Boolean);
const NARROWED = WANT.length > 0;
const LABEL = NARROWED ? `a build declaring ${WANT.join(" + ")} ships only those spaces`
                       : "a build declaring nothing ships every space";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.log(`        ${name}: expected ${e}, got ${a}`);
}

app.whenReady().then(async () => {
  try {
    await sleep(400);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("no window");
    await new Promise((res) => (win.webContents.isLoading() ? win.webContents.once("did-finish-load", res) : res()));
    await sleep(1200); // the rail is wired at load; give the renderer its first frame

    // A profile left on disk by an earlier run would mask the build default, and
    // this is the real userData store rather than the preview server's origin.
    // Clear it, re-apply, and read the rail the way a user sees it.
    const seen = await win.webContents.executeJavaScript(`(() => {
      localStorage.removeItem("crowe-spaces");
      applySpaceProfile();
      const rail = [...document.querySelectorAll('#spaces .seg-btn')]
        .filter((b) => !b.classList.contains("hidden")).map((b) => b.dataset.space);
      return { bridged: window.crowe.installSpaces, profile: [...PROFILE], rail,
               stored: localStorage.getItem("crowe-spaces") };
    })()`);

    // The value crossed main -> argv -> preload intact.
    check("window.crowe.installSpaces", seen.bridged, NARROWED ? WANT : null);
    // ...and the renderer acted on it. Chat is never optional, so it is present
    // either way; the rail is what someone actually sees.
    const expected = NARROWED ? ["chat", ...WANT.filter((id) => id !== "chat")] : ["chat", "projects", "cultivation"];
    check("PROFILE", seen.profile, expected);
    check("visible rail buttons", seen.rail, expected);
    // A build default is the build talking, not a choice anyone made. Writing it
    // would freeze this install's set against every version that adds a space.
    check("stored profile", seen.stored, null);

    console.log(`${failures ? "not ok" : "ok    "}  ${LABEL}`);
  } catch (error) {
    failures++;
    console.log(`not ok  ${LABEL}`);
    console.error("        harness error:", error && error.stack ? error.stack : error);
  } finally {
    // app.exit skips the quit events, so tear the native children down by hand
    // and give them a moment, the same way smoke-shot.js does.
    shutdownNativeResources();
    await sleep(250);
    app.exit(failures ? 1 : 0);
  }
});
