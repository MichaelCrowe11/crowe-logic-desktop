#!/usr/bin/env node
"use strict";

// No build, signing, network or installed profile. Stage the explicitly allowed
// farm files, then start the actual worker there: require traversal alone cannot
// discover a new Worker(path.join(__dirname, "worker.js")) dependency.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const pkg = JSON.parse(read("package.json"));
const matches = (pattern, rel) => pattern === rel || (pattern.endsWith("/**") && rel.startsWith(pattern.slice(0, -2)));
const included = (rel) => pkg.build.files.some(p => !p.startsWith("!") && matches(p, rel)) &&
  !pkg.build.files.some(p => p.startsWith("!") && matches(p.slice(1), rel));

test("farm Worker, store and UI assets are explicit package inputs", () => {
  assert.ok(pkg.build.files.includes("farm/**"));
  assert.equal(included("farm/fixtures.js"), false, "synthetic farm fixture must not ship");
  for (const file of ["farm/service.js", "farm/worker.js", "farm/store.js", "farm/schema.js", "farm/validation.js",
    "app-edition.js", "grow-transfer.js", "farm/transfer-host.js",
    "renderer/farm-recovery.js", "renderer/farm-compliance.js", "renderer/farm-compliance.css",
    "renderer/mycology-transfer.js", "renderer/mycology-transfer.css"]) {
    assert.ok(included(file), `${file} excluded from package`);
    assert.ok(fs.statSync(path.join(root, file)).isFile(), `${file} missing`);
  }
});

test("staged package starts the actual SQLite worker and persists records", { timeout: 25000 }, async () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-farm-package-"));
  let service;
  try {
    function copy(dir) {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) { copy(rel); continue; }
        if (!included(rel)) continue;
        const dest = path.join(stage, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(root, rel), dest);
      }
    }
    copy("farm");
    const { FarmService } = require(path.join(stage, "farm/service.js"));
    const filename = path.join(stage, "profile", "farm-compliance", "farm.db");
    service = new FarmService({ filename });
    const initial = await service.request("snapshot");
    assert.equal(initial.storage.kind, "desktop-local");
    assert.equal(initial.lots.length, 0);
    await service.request("facility.save", { name: "Package fixture", ownerName: "Test operator" });
    await service.close();
    service = new FarmService({ filename });
    assert.equal((await service.request("snapshot")).facility.name, "Package fixture");
    assert.ok(fs.existsSync(filename));
  } finally {
    if (service) await service.close();
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test("desktop, browser and generated preview load farm assets once before renderer", () => {
  for (const file of ["renderer/index.html", "renderer/app.html", "renderer/preview.html"]) {
    const html = read(file);
    assert.equal((html.match(/id="surface-farm"/g) || []).length, 1, file);
    assert.equal((html.match(/data-space="farm"/g) || []).length, 1, file);
    assert.equal((html.match(/href="farm-compliance\.css(?:\?[^"]*)?"/g) || []).length, 1, file);
    assert.equal((html.match(/src="farm-compliance\.js(?:\?[^"]*)?"/g) || []).length, 1, file);
    assert.ok(html.indexOf('src="farm-compliance.js') < html.indexOf('src="renderer.js'), file);
    if (file !== "renderer/index.html") {
      for (const ext of ["js", "css"]) assert.match(html, new RegExp(`farm-compliance\\.${ext}\\?v=\\d+`));
    }
  }
});

test("all shells load recovery before the ledger and transfer before the renderer exactly once", () => {
  for (const file of ["renderer/index.html", "renderer/app.html", "renderer/preview.html"]) {
    const html = read(file);
    const scripts = [...html.matchAll(/<script\b[^>]*src="([^"?]+)(?:\?[^"\s]*)?"/g)].map((match) => match[1]);
    const styles = [...html.matchAll(/<link\b[^>]*href="([^"?]+)(?:\?[^"\s]*)?"/g)].map((match) => match[1]);
    for (const asset of ["farm-recovery.js", "farm-compliance.js", "mycology-transfer.js", "renderer.js"]) {
      assert.equal(scripts.filter((entry) => entry === asset).length, 1, `${file}: ${asset}`);
    }
    assert.ok(scripts.indexOf("farm-recovery.js") < scripts.indexOf("farm-compliance.js"), file);
    assert.ok(scripts.indexOf("farm-compliance.js") < scripts.indexOf("mycology-transfer.js"), file);
    assert.ok(scripts.indexOf("mycology-transfer.js") < scripts.indexOf("renderer.js"), file);
    assert.equal(styles.filter((entry) => entry === "mycology-transfer.css").length, 1, file);
    if (file !== "renderer/index.html") {
      for (const asset of ["farm-recovery.js", "mycology-transfer.js", "mycology-transfer.css"]) assert.ok(html.includes(`${asset}?v=`), `${file}: ${asset} not stamped`);
    }
  }
});

test("non-desktop farm bridges refuse reads, writes, adoption and restore without a second store", async () => {
  for (const file of ["renderer/preview-shim.js", "renderer/web-bridge.js", "mobile/src/mobile-bridge.js"]) {
    // Evaluate the exact exposed farm object in an empty VM. Any reference to
    // storage, networking, companion routes or a simulated store must fail here.
    const source = read(file);
    const match = source.match(/^    farm: (\{[\s\S]*?^    \}),/m);
    assert.ok(match, `${file} must expose a farm namespace`);
    const farm = vm.runInNewContext(`(${match[1]})`, {});
    assert.deepEqual(Object.keys(farm).sort(), ["legacyHarvests", "request"]);
    for (const action of ["snapshot", "lot.create", "lot.correct", "lot.adopt", "shipment.create", "backup.restore"]) {
      const result = await farm.request(action, {});
      assert.equal(result.ok, false, `${file}: ${action}`);
      assert.equal(result.error.code, "UNAVAILABLE");
      assert.equal(typeof result.error.message, "string");
      assert.equal(result.data, undefined);
    }
    assert.equal((await farm.legacyHarvests()).error.code, "UNAVAILABLE");
  }
});

test("general mobile excludes Mycology drivers; web retains existing farm assets", () => {
  execFileSync(process.execPath, [path.join(root, "mobile/scripts/build-www.js")], { cwd: root, stdio: "pipe" });
  const html = read("mobile/www/index.html");
  for (const asset of ["farm-compliance.css", "farm-compliance.js", "farm-recovery.js", "mycology-transfer.js", "mycology-transfer.css",
    "farm-messenger.js", "farm-messenger.css", "farm-team.js", "farm-team.css", "farm-imports.js", "farm-imports.css",
    "farm-workforce.js", "farm-workforce.css", "farm-awareness.js", "farm-awareness.css"]) {
    assert.ok(!fs.existsSync(path.join(root, "mobile/www", asset)), `general mobile must not ship ${asset}`);
    assert.ok(!html.includes(`"${asset}`), `general mobile must not load ${asset}`);
  }
  for (const asset of ["farm-compliance.css", "farm-compliance.js", "farm-recovery.js", "mycology-transfer.js", "mycology-transfer.css"]) {
    assert.ok(read("scripts/deploy-web.sh").includes(`renderer/${asset}`), `web deploy omits ${asset}`);
  }
  assert.equal((html.match(/data-space="farm"/g) || []).length, 1, "phone sidebar must retain the desktop-only explanation");
});
