'use strict';

// deploy-web.sh ships app.html with every ?v= asset stamp rewritten to HEAD's
// commit time, so a browser holding the previous renderer.js or styles.css in
// cache fetches the new ones. The committed stamp had not moved since
// 2026-09-07 while six renderer changes shipped behind it (PR 102 review).
// This holds the rewrite to that contract, and holds the ship list to files
// that exist, without touching the VM. It found renderer/activity.js listed
// as a bare `activity.js`, which no scp could have copied.

const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/deploy-web.sh');
const run = (args) => execFileSync('bash', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const stamps = (html) => [...html.matchAll(/\?v=(\d+)/g)].map((m) => m[1]);
const neutral = (html) => html.replace(/\?v=\d+/g, '?v=0');

const committed = fs.readFileSync(path.join(ROOT, 'renderer/app.html'), 'utf8');
const shipped = run(['--stamped-app-html']);
const head = git(['log', '-1', '--format=%ct']);
const source = fs.readFileSync(SCRIPT, 'utf8');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', `${name}: ${e.message}`]); }
}

check('the committed app.html carries stamped asset tags to rewrite', () => {
  assert.ok(stamps(committed).length >= 10, `only ${stamps(committed).length} stamped tags`);
});

check("every stamp in the shipped app.html is HEAD's commit time", () => {
  const s = stamps(shipped);
  assert.strictEqual(s.length, stamps(committed).length, 'a stamped tag was lost or gained');
  assert.ok(/^\d{10}$/.test(head), `HEAD commit time reads ${head}`);
  assert.deepStrictEqual([...new Set(s)], [head]);
});

check('the rewrite changes nothing but the stamps', () => {
  assert.strictEqual(neutral(shipped), neutral(committed));
});

check('the stamp is stable for a commit, so --check can rebuild the shipped file', () => {
  assert.strictEqual(run(['--stamped-app-html']), shipped);
});

check('every file on the ship list exists in the tree', () => {
  const m = /^FILES=\((.*)\)$/m.exec(source);
  assert.ok(m, 'could not find the FILES list in deploy-web.sh');
  const listed = m[1].split(/\s+/).filter(Boolean);
  const missing = listed.filter((f) => !f.startsWith('"$TMPD/')).filter((f) => !fs.existsSync(path.join(ROOT, f)));
  assert.deepStrictEqual(missing, [], 'listed but not in the tree');
  assert.ok(listed.includes('renderer/activity.js'), 'activity.js ships from renderer/');
  assert.strictEqual(listed[0], '"$TMPD/app.html"', 'app.html ships in its stamped form');
});

check('the script parses and passes shellcheck when shellcheck is installed', () => {
  execFileSync('bash', ['-n', SCRIPT]);
  try { execFileSync('shellcheck', ['-S', 'warning', SCRIPT], { encoding: 'utf8' }); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(e.stdout || e.message); }
});

for (const [s, n] of results) console.log(`${s.padEnd(4)}\t${n}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
