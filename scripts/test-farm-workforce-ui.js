#!/usr/bin/env node
'use strict';
// Isolated Electron DOM tests with a mocked bridge. Not proof of a live backend.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'renderer/farm-workforce.js'), 'utf8');
assert(!/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|fetch\(|XMLHttpRequest|eval\(/.test(source), 'No HTML injection, persistence, inference or independent transport');
if (!process.versions.electron) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-workforce-ui-'));
  const env = { ...process.env, HOME: home, WORKFORCE_TEST_HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 120000 });
  if (child.error) console.error(child.error);
  process.exit(child.status === null ? 1 : child.status);
}
const { app, BrowserWindow, session } = require('electron');
const home = process.env.WORKFORCE_TEST_HOME;
if (!home || !path.basename(home).startsWith('crowe-workforce-ui-')) throw new Error('Run the Node launcher for an isolated home.');
for (const name of ['home', 'userData', 'sessionData', 'logs', 'crashDumps', 'downloads']) {
  const target = path.join(home, name); fs.mkdirSync(target, { recursive: true }); app.setPath(name, target);
}
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const url = name => pathToFileURL(path.join(root, name)).href;
fs.writeFileSync(path.join(home, 'fixture.css'), 'html,body,#host{margin:0;width:100%;height:100%;overflow:hidden}');
fs.writeFileSync(path.join(home, 'fixture.html'), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' file:; style-src 'self' file:; connect-src 'none'; object-src 'none'; base-uri 'none'"><link rel="stylesheet" href="${url('renderer/farm-workforce.css')}"><link rel="stylesheet" href="fixture.css"><script defer src="${url('renderer/farm-workforce.js')}"></script></head><body><main id="host"></main></body></html>`);
let win;
app.whenReady().then(async () => {
  try {
    const isolated = session.fromPartition('workforce-ui-test');
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['file:', 'data:', 'devtools:'].includes(new URL(details.url).protocol) }));
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win = new BrowserWindow({ width: 1000, height: 900, show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadFile(path.join(home, 'fixture.html'));
    const result = await win.webContents.executeJavaScript(`(${browserTests.toString()})()`);
    result.passed.forEach(test => console.log('PASS ' + test));
    if (result.error) throw new Error(result.error);
    for (const width of [1000, 390]) {
      win.setContentSize(width, 900);
      const fits = await win.webContents.executeJavaScript('(async()=>{await new Promise(r=>requestAnimationFrame(r));const n=document.querySelector(".farm-workforce");return n.scrollWidth<=n.clientWidth+1})()');
      assert(fits, 'Responsive layout fits ' + width + 'px');
    }
    await win.webContents.executeJavaScript('window.workforceTest.destroy()');
    console.log(`Workforce UI: ${result.passed.length + 1} checks passed (mock bridge only).`);
    win.destroy(); app.exit(0);
  } catch (err) { console.error(err.stack); if (win) win.destroy(); app.exit(1); }
});

async function browserTests() {
  const passed = [], q = selector => document.querySelector(selector);
  const assert = (yes, label) => { if (!yes) throw new Error(label); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const wait = async test => { for (let i = 0; i < 300; i++) { if (test()) return; await tick(); } throw new Error('Wait expired: ' + test.toString()); };
  const ok = data => ({ ok: true, data });
  const clone = value => JSON.parse(JSON.stringify(value));
  let instance, calls, handlers, ownRows, sheets, role;
  const bridge = { async request(action, p) {
    calls.push({ action, payload: clone(p) });
    if (handlers[action]) return handlers[action](p);
    if (action === 'time.list') return ok({ items: ownRows });
    if (action === 'timesheet.list') return ok({ items: sheets });
    if (action === 'department.list') return ok({ items: [{ id: 'dep', name: 'Grow fixture' }] });
    if (action === 'payroll.config') return ok({ configured: false, config: null });
    return { ok: false, error: { code: 'unsupported', message: 'Unsupported fixture action' } };
  } };
  async function mount(memberRole = 'worker', custom = bridge) {
    instance?.destroy(); role = memberRole; calls = []; handlers = {}; ownRows = []; sheets = [];
    instance = FarmWorkforce.mount(q('#host'), custom, { farmId: 'farm-fixture', currentMemberId: 'self', role });
    window.workforceTest = instance; await tick(); await tick();
  }
  const loaded = () => q('[data-fw=status]').textContent.startsWith('Records received');
  const click = async selector => { q(selector).click(); await tick(); };
  try {
    await mount('worker', {});
    await wait(() => q('[data-fw=status]').textContent.includes('unavailable'));
    assert(q('[data-fw=clock_in]').disabled, 'Unavailable service cannot clock in');
    assert(!q('[data-fw=history]').textContent.includes('fixture'), 'No fake history');
    passed.push('honest unavailable state and no synthetic records');

    await mount(); await wait(loaded);
    assert(q('[aria-label="CSV payroll handoff"]').hidden, 'Payroll hidden from worker');
    assert(!calls.some(c => c.action.startsWith('payroll.')), 'Worker never fetches payroll');
    q('[data-fw=job]').value = 'GROW'; q('[data-fw=department]').value = 'dep';
    let first = true;
    handlers['time.clock_in'] = p => { if (first) { first = false; throw new Error('Lost response'); } ownRows = [{ id: 'shift', userId: 'self', startedAt: p.occurredAt, endedAt: null, jobCode: 'GROW', breaks: [], openBreakAt: null }]; return ok(ownRows[0]); };
    await click('[data-fw=clock_in]'); await wait(() => !q('[data-fw=retry]').hidden && !q('[data-fw=retry]').disabled);
    const original = clone(calls.find(c => c.action === 'time.clock_in'));
    assert(q('[data-fw=clock_in]').disabled, 'Unknown outcome blocks replacement commands');
    await click('[data-fw=retry]'); await wait(loaded);
    const punches = calls.filter(c => c.action === 'time.clock_in');
    assert(JSON.stringify(punches[1]) === JSON.stringify(original), 'Retry preserves ID, occurrence time and all command bytes');
    assert(original.payload.timezone && /[+-]\d\d:\d\d$/.test(original.payload.occurredAt), 'Punch records explicit offset and timezone');
    assert(original.payload.offline === false && !('userId' in original.payload), 'Authenticated self-punch only');
    assert(!q('[data-fw=break_start]').disabled && !q('[data-fw=clock_out]').disabled, 'Accepted open shift enables break and out');
    passed.push('private self punches, exact retry and unknown-outcome safety');

    let resolveLate;
    handlers['time.list'] = () => new Promise(resolve => { resolveLate = resolve; });
    instance.open(); await tick(); instance.deactivate();
    assert(q('.farm-workforce').hidden && !q('[data-fw=history]').textContent, 'Deactivation hides and clears personnel data');
    resolveLate(ok({ items: [{ id: 'late', startedAt: 'PRIVATE-LATE', jobCode: 'secret' }] })); await tick(); await tick();
    assert(!q('[data-fw=history]').textContent.includes('PRIVATE-LATE'), 'Late response cannot repopulate hidden private records');
    instance.destroy(); assert(!q('.farm-workforce'), 'Destroy removes private surface');
    passed.push('deactivation, late-response isolation and account teardown');

    await mount('owner'); await wait(loaded);
    sheets = [{ id: 'sheet-approved', status: 'approved', user_id: 'worker', revision_hash: 'a'.repeat(64), snapshot: { userId: 'worker', shifts: [] } }, { id: 'sheet-draft', status: 'draft', user_id: 'worker', revision_hash: 'b'.repeat(64), snapshot: { userId: 'worker', shifts: [] } }];
    ownRows = [{ id: 's', startedAt: '<img src=x onerror=alert(1)>', endedAt: 'done', jobCode: 'GROW', revisionHash: 'c'.repeat(64) }];
    await instance.open(); await wait(loaded);
    assert(!q('[data-fw=history] img') && q('[data-fw=history]').textContent.includes('<img'), 'History is escaped text');
    await click('[data-approve=sheet-draft]'); assert(!calls.some(c => c.action === 'timesheet.approve'), 'Approval requires explicit checkbox');
    q('[data-fw="approve-sheet-draft"]').checked = true;
    handlers['timesheet.approve'] = () => ok({ id: 'sheet-draft', status: 'approved' });
    await click('[data-approve=sheet-draft]'); await wait(loaded);
    const approval = calls.find(c => c.action === 'timesheet.approve');
    assert(approval.payload.revisionHash === 'b'.repeat(64), 'Approval bound to displayed hash');
    passed.push('safe text rendering and explicit exact-revision approval');

    const payloadHash = 'd'.repeat(64);
    handlers['payroll.preview'] = () => ok({ destination: 'Fixture CSV', revisions: [{ id: 'sheet-approved', revisionHash: 'a'.repeat(64) }], payloadHash, configHash: 'e'.repeat(64), csvSha256: 'f'.repeat(64), csv: '"employeeId","seconds"\r\n"123","3600"\r\n' });
    handlers['payroll.export'] = () => ok({ id: 'export-fixture', status: 'artifact_created', destination: 'Fixture CSV', payloadHash, csvSha256: 'f'.repeat(64), externalSubmission: false, csv: '"employeeId","seconds"\r\n"123","3600"\r\n' });
    q('[data-sheet=sheet-approved]').checked = true;
    await click('[data-fw=preview-export]'); await wait(() => q('[data-fw=export-view]').textContent.includes(payloadHash));
    assert(q('[data-fw=export]').disabled, 'Preview is not an export authorization');
    q('[data-fw=confirm]').checked = true; q('[data-fw=confirm]').dispatchEvent(new Event('change'));
    await click('[data-fw=export]'); await wait(() => q('[data-fw=export-view]').textContent.includes('export-fixture'));
    const exported = calls.find(c => c.action === 'payroll.export');
    assert(exported.payload.confirmed === true && exported.payload.payloadHash === payloadHash, 'Export confirms exact preview hash');
    assert(q('[data-fw=export-view]').textContent.includes('No external submission'), 'Receipt cannot imply paid wages or provider delivery');
    assert([...document.querySelectorAll('input,select,textarea')].every(n => n.labels.length), 'All controls labeled');
    passed.push('owner-only CSV preview, human confirmation, bound receipt and labels');
    return { passed };
  } catch (err) { return { passed, error: err.stack }; }
}
