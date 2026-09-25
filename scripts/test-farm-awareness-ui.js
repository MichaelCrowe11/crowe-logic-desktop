#!/usr/bin/env node
'use strict';
// Isolated Electron renderer, mocked authenticated bridge, all network denied.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'renderer/farm-awareness.js'), 'utf8');
assert(!/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|fetch\(|XMLHttpRequest|eval\(/.test(source));
if (!process.versions.electron) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-awareness-ui-'));
  const env = { ...process.env, HOME: home, AWARENESS_TEST_HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 120000 });
  if (child.error) console.error(child.error);
  process.exit(child.status === null ? 1 : child.status);
}
const { app, BrowserWindow, session } = require('electron');
const home = process.env.AWARENESS_TEST_HOME;
if (!home || !path.basename(home).startsWith('farm-awareness-ui-')) throw Error('Launch with Node for isolated profile.');
for (const name of ['home', 'userData', 'sessionData', 'logs', 'crashDumps', 'downloads']) { const p = path.join(home, name); fs.mkdirSync(p, { recursive: true }); app.setPath(name, p); }
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const url = name => pathToFileURL(path.join(root, name)).href;
fs.writeFileSync(path.join(home, 'fixture.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' file:; style-src 'self' file:; connect-src 'none'; object-src 'none'; base-uri 'none'"><link rel="stylesheet" href="${url('renderer/farm-awareness.css')}"><script defer src="${url('renderer/farm-awareness.js')}"></script><main id="host"></main>`);
let win;
app.whenReady().then(async () => {
  try {
    const isolated = session.fromPartition('awareness-fixture');
    isolated.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !['file:', 'data:', 'devtools:'].includes(new URL(d.url).protocol) }));
    isolated.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    win = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadFile(path.join(home, 'fixture.html'));
    const result = await win.webContents.executeJavaScript(`(${browserTests.toString()})()`);
    if (result.error) throw Error(result.error);
    for (const name of result.passed) console.log('PASS ' + name);
    for (const width of [1100, 390]) {
      win.setContentSize(width, 850);
      const box = await win.webContents.executeJavaScript(`(async()=>{await new Promise(r=>requestAnimationFrame(r));const n=document.querySelector('.farm-awareness');return {scroll:n.scrollWidth,client:n.clientWidth}})()`);
      assert(box.scroll <= box.client + 1, 'No horizontal overflow at ' + width);
    }
    console.log(`Awareness UI: ${result.passed.length + 1} checks passed. Mock bridge, not live service delivery.`);
    win.destroy(); app.exit(0);
  } catch (err) { console.error(err.stack); if (win) win.destroy(); app.exit(1); }
});

async function browserTests() {
  const passed = [], q = s => document.querySelector(s), qa = s => [...document.querySelectorAll(s)];
  const assert = (x, m) => { if (!x) throw Error(m); };
  const tick = () => new Promise(r => setTimeout(r, 0));
  const wait = async fn => { for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); } throw Error('Timed out ' + fn.toString()); };
  const click = async selector => { assert(q(selector), 'Missing ' + selector); q(selector).click(); await tick(); await wait(() => q('.farm-awareness')?.getAttribute('aria-busy') !== 'true'); };
  const ok = data => ({ ok: true, data });
  const hash = 'a'.repeat(64), calls = [];
  let training = { id: 't1', document_id: 'doc1', document_version: 1, document_hash: hash, user_id: 'worker', version: 1, stale: false, complete: false, acknowledged_at: null, assessed_at: null, signed_off_at: null };
  let incident = { id: 'i1', rule_id: 'r1', version: 1, status: 'open', source: { logId: 'log1', observedAt: '2026-09-24T10:00:00Z' }, notifications: [{ kind: 'opened', status: 'queued' }] };
  let failAck = false, hold;
  const bridge = { async request(action, p) {
    calls.push({ action, p: JSON.parse(JSON.stringify(p)) });
    if (hold) return new Promise(resolve => { hold.resolve = resolve; });
    if (action === 'knowledge.list') return ok({ items: [{ id: 'doc1', title: '<img src=x onerror=alert(1)>Fixture SOP', version: 1, version_hash: hash }] });
    if (action === 'knowledge.read') return ok({ title: 'Approved fixture', text: '<script>window.injected=true</script>\nExact approved procedure', citation: { documentId: 'doc1', version: 1, versionHash: hash, startLine: 1, endLine: 2 }, nextLine: null });
    if (action === 'training.list') return ok({ items: [training] });
    if (action === 'training.read') return ok({ ...training });
    if (action === 'training.acknowledge') {
      if (failAck) { failAck = false; throw Error('connection lost'); }
      training = { ...training, version: 2, acknowledged_at: '2026-09-24T11:00:00Z' }; return ok({ ...training });
    }
    if (action === 'incident.list') return ok({ items: [incident] });
    if (action === 'incident.read') return ok({ ...incident });
    if (action === 'incident.acknowledge') { incident = { ...incident, status: 'acknowledged', version: 2 }; return ok({ ...incident }); }
    if (action === 'incident.resolve') return { ok: false, error: { message: 'Fresh accepted clear evidence is required' } };
    if (action === 'rule.list') return ok({ items: [{ id: 'r1', name: 'Fixture policy', status: 'draft', version: 1, config: { kind: 'threshold', raiseAt: 10, clearAt: 8, units: 'fixture-unit' } }] });
    if (action === 'rule.preview') return ok({ id: 'r1', version: 1, previewHash: hash, dryRun: true, notificationsSent: 0 });
    if (action === 'rule.activate') return ok({ id: 'r1', version: 2, status: 'active' });
    throw Error('Unexpected ' + action);
  } };
  let instance;
  async function mount(role = 'worker') {
    instance?.destroy();
    instance = FarmAwareness.mount(q('#host'), bridge, { farmId: 'f1', currentMemberId: 'worker', role });
    await wait(() => q('.farm-awareness')?.getAttribute('aria-busy') === 'false');
  }
  try {
    await mount();
    await click('[data-fa=record]');
    assert(!q('img') && !q('script:not([src])') && !window.injected, 'Untrusted document text is inert');
    assert(q('[data-fa=detail]').textContent.includes(hash), 'Exact hash citation rendered');
    assert(calls.every(c => !c.action.startsWith('training.ack')), 'Read never acknowledges');
    passed.push('approved SOP text and exact citations, no script execution or read completion');
    await click('[data-fa=tab-training]'); await click('[data-fa=record]');
    await click('[data-fa=training-ack]');
    assert(!calls.some(c => c.action === 'training.acknowledge'), 'Explicit acknowledgment checkbox required');
    q('[data-fa=training-confirm]').checked = true;
    failAck = true; await click('[data-fa=training-ack]');
    assert(!q('[data-fa=error]').hidden, 'Unknown result visible');
    await click('[data-fa=training-ack]');
    const attempts = calls.filter(c => c.action === 'training.acknowledge');
    assert(attempts.length === 2 && attempts[0].p.requestId === attempts[1].p.requestId, 'Retry retains same request ID');
    assert(q('[data-fa=detail]').textContent.includes('Not complete'), 'Acknowledgment not sign-off');
    assert(!q('[data-fa=training-ack]'), 'No duplicate ack after confirmed refresh');
    passed.push('explicit employee acknowledgment, durable intent retry in view, no auto completion');
    training.stale = true;
    await click('[data-fa=refresh]'); await click('[data-fa=record]');
    assert(q('[data-fa=detail]').textContent.includes('Stale assignment'), 'Stale revision clear');
    assert(!q('[data-fa=training-ack]') && !q('[data-fa=training-sop]'), 'Stale training blocked');
    passed.push('revised training visibly stale, no stale acknowledgment');
    await click('[data-fa=tab-incident]'); await click('[data-fa=record]');
    assert(!q('[data-fa=incident-resolve]'), 'Worker has no manager resolve');
    await click('[data-fa=incident-ack]');
    assert(q('[data-fa=detail]').textContent.includes('acknowledged'), 'Ack separate status');
    assert(q('[data-fa=detail]').textContent.includes('Queued is not delivered'), 'Delivery not invented');
    passed.push('staff incident acknowledgment distinct from resolution and actual delivery');
    await mount('owner'); await click('[data-fa=tab-incident]'); await click('[data-fa=record]');
    q('[data-fa=resolve-note]').value = 'Fixture manager evidence'; q('[data-fa=resolve-confirm]').checked = true;
    await click('[data-fa=incident-resolve]');
    assert(q('[data-fa=error]').textContent.includes('Fresh accepted clear'), 'Server resolution gate retained');
    assert(q('[data-fa=detail]').textContent.includes('acknowledged'), 'Rejected resolve not optimistic success');
    passed.push('manager resolution explicit and fresh-evidence denial visible');
    await click('[data-fa=tab-rule]'); await click('[data-fa=record]');
    assert(calls.some(c => c.action === 'rule.preview'), 'Read-only preview called');
    await click('[data-fa=rule-activate]');
    assert(!calls.some(c => c.action === 'rule.activate'), 'Activation requires reviewed checkbox');
    q('[data-fa=rule-confirm]').checked = true; await click('[data-fa=rule-activate]');
    assert(calls.find(c => c.action === 'rule.activate').p.previewHash === hash, 'Activation binds exact preview');
    passed.push('rule dry-run preview before explicit hash-bound activation');
    await mount('viewer'); await click('[data-fa=tab-training]'); await click('[data-fa=record]');
    assert(!q('[data-fa=training-ack]'), 'Viewer read-only');
    hold = {}; q('[data-fa=refresh]').click(); await wait(() => hold.resolve);
    instance.deactivate(); const resolver = hold.resolve; hold = null; resolver(ok({ items: [{ id: 'late', title: 'PRIVATE LATE RESPONSE' }] }));
    await tick(); await tick(); assert(!q('[data-fa=list]').textContent.includes('PRIVATE'), 'Deactivation discards late response');
    await instance.open(); await wait(() => q('.farm-awareness').getAttribute('aria-busy') === 'false');
    const before = calls.length; instance.destroy(); await tick(); assert(!q('.farm-awareness'), 'Destroy removes private DOM'); assert(calls.length === before, 'Destroy performs no writes');
    passed.push('viewer gating, lifecycle clears content and suppresses late responses');
    await mount('owner');
    assert(calls.every(c => c.p.farmId === 'f1'), 'Host-selected farm pinned on every request');
    assert(calls.every(c => /^(knowledge|training|incident|rule)\./.test(c.action)), 'No inference or transport side-channel');
    passed.push('all calls scoped to supplied farm, no inference actions');
    return { passed };
  } catch (e) { instance?.destroy(); return { passed, error: e.stack }; }
}
