#!/usr/bin/env node
'use strict';
// Isolated Chromium DOM tests. Mocked bridge only, all network denied.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'renderer/farm-messenger.js'), 'utf8');
assert(!/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|fetch\(|XMLHttpRequest|eval\(/.test(source), 'No HTML injection, browser persistence or independent transport');
if (!process.versions.electron) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-messenger-test-'));
  const env = { ...process.env, HOME: home, MESSENGER_TEST_HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 120000 });
  if (child.error) console.error(child.error);
  process.exit(child.status === null ? 1 : child.status);
}
const { app, BrowserWindow, session } = require('electron');
const home = process.env.MESSENGER_TEST_HOME;
if (!home || !path.basename(home).startsWith('crowe-messenger-test-')) throw new Error('Use Node launcher for an isolated test home.');
for (const name of ['home', 'userData', 'sessionData', 'logs', 'crashDumps', 'downloads']) {
  const target = path.join(home, name); fs.mkdirSync(target, { recursive: true }); app.setPath(name, target);
}
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const url = name => pathToFileURL(path.join(root, name)).href;
fs.writeFileSync(path.join(home, 'fixture.css'), 'html,body,#host{margin:0;width:100%;height:100%;overflow:hidden}');
fs.writeFileSync(path.join(home, 'fixture.html'), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' file:; style-src 'self' file:; font-src 'self' file:; connect-src 'none'; object-src 'none'; base-uri 'none'"><link rel="stylesheet" href="${url('renderer/farm-messenger.css')}"><link rel="stylesheet" href="fixture.css"><script defer src="${url('renderer/farm-messenger.js')}"></script><script defer src="${url('renderer/farm-team.js')}"></script></head><body><main id="host"></main></body></html>`);
let win;
app.whenReady().then(async () => {
  try {
    const partition = session.fromPartition('messenger-test-isolated');
    partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['file:', 'data:', 'devtools:'].includes(new URL(details.url).protocol) }));
    partition.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win = new BrowserWindow({ width: 1180, height: 900, show: false, webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadFile(path.join(home, 'fixture.html'));
    const result = await win.webContents.executeJavaScript(`(${browserTests.toString()})()`);
    for (const name of result.passed) console.log('PASS ' + name);
    if (result.error) throw new Error(result.error);
    for (const [width, dark, thread] of [[1180, false, false], [1180, true, true], [390, false, false], [390, false, true]]) {
      win.setContentSize(width, 900);
      const state = await win.webContents.executeJavaScript(`(async () => {
        document.body.classList.toggle('dark', ${dark}); document.querySelector('.farm-messenger').classList.toggle('fm-thread-open', ${thread});
        await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const root = document.querySelector('.farm-messenger'), sidebar = root.querySelector('.fm-sidebar'), detail = root.querySelector('.fm-detail');
        return {width:innerWidth,scroll:root.scrollWidth,client:root.clientWidth,sidebar:getComputedStyle(sidebar).display,detail:getComputedStyle(detail).display};
      })()`);
      assert(state.scroll <= state.client + 1, 'No horizontal overflow: ' + JSON.stringify(state));
      if (width === 390) { assert.equal(state.sidebar === 'none', thread); assert.equal(state.detail === 'none', !thread); }
      win.webContents.debugger.attach('1.3');
      const image = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      win.webContents.debugger.detach();
      fs.writeFileSync(path.join(home, `messenger-${width}-${dark ? 'dark' : 'light'}-${thread ? 'thread' : 'list'}.png`), Buffer.from(image.data, 'base64'));
    }
    console.log('PASS responsive 390px and 1180px layouts, light/dark screenshots');
    await win.webContents.executeJavaScript('window.messengerTest.destroy()');
    console.log(`Messenger: ${result.passed.length + 2} checks passed. Mock-only evidence: ${home}`);
    win.destroy(); app.exit(0);
  } catch (err) { console.error(err.stack); if (win) win.destroy(); app.exit(1); }
});

async function browserTests() {
  const passed = [], q = s => document.querySelector(s), qa = s => [...document.querySelectorAll(s)];
  const assert = (condition, label) => { if (!condition) throw new Error(label); };
  const equal = (a, b, label) => assert(JSON.stringify(a) === JSON.stringify(b), `${label}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  const tick = () => new Promise(r => setTimeout(r, 0));
  const wait = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); } throw new Error('Timed out: ' + predicate.toString()); };
  const ok = data => ({ ok: true, data }), bad = message => ({ ok: false, error: { code: 'UNAVAILABLE', message } });
  const clone = value => JSON.parse(JSON.stringify(value));
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const click = async selector => { assert(q(selector), 'Missing ' + selector); q(selector).click(); await tick(); };
  const set = (selector, value) => { const node = q(selector); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return node; };
  const stamp = '2026-09-24T09:00:00Z';
  const baseFarms = [{ id: 'f1', name: 'Fixture farm one', currentMemberId: 'self', role: 'owner' }, { id: 'f2', name: 'Fixture farm two', currentMemberId: 'self2', role: 'worker' }];
  const baseMembers = [{ id: 'self', name: 'Fixture operator', kind: 'human', isSelf: true }, { id: 'worker', name: 'Fixture worker', role: 'worker', kind: 'human' }];
  const baseConversations = [{ id: 'c1', title: 'Packing fixture', kind: 'direct', memberIds: ['self', 'worker'], unreadCount: 2 }, { id: 'c2', title: 'Department fixture', kind: 'department', memberIds: ['self', 'worker'], unreadCount: 0 }];
  let farms, members, conversations, rows, calls, handlers, instance;
  const bridge = { request(action, payload) {
    calls.push({ action, payload: clone(payload) });
    if (handlers[action]) return handlers[action](payload);
    if (action === 'farm.list') return ok({ items: clone(farms) });
    if (action === 'member.list') return ok({ items: clone(members) });
    if (action === 'conversation.list') return ok({ items: clone(conversations) });
    if (action === 'department.list') return ok({ items: [{ id: 'd1', name: 'Packing' }] });
    if (action === 'message.list') return ok({ items: clone(rows[payload.conversationId] || []).filter(row => row.sequence > (payload.afterSequence || 0)), hasMore: false });
    if (action === 'message.read') return ok({ sequence: payload.sequence });
    if (action === 'message.send') { const list = rows[payload.conversationId] || (rows[payload.conversationId] = []); const row = { id: 'm' + calls.length, authorId: 'self', text: payload.text, requestId: payload.requestId, sequence: list.length + 1, createdAt: stamp }; list.push(row); return ok(clone(row)); }
    return bad('No handler for fixture ' + action);
  } };
  async function remount(custom = bridge) {
    instance?.destroy(); farms = clone(baseFarms); members = clone(baseMembers); conversations = clone(baseConversations);
    rows = { c1: [{ id: 'm1', authorId: 'worker', text: '<img src=x onerror="window.injected=true">\nFixture body', createdAt: stamp, sequence: 1 }], c2: [] };
    calls = []; handlers = {}; instance = FarmMessenger.mount(q('#host'), custom); window.messengerTest = instance;
    await tick(); await tick();
  }
  async function selectFarm(value = 'f1') { set('[data-fm="farm"]', value); await wait(() => q('[data-fm="status"]').textContent.includes('Connected')); }
  async function selectThread(value = 'c1') { await click(`[data-conversation="${value}"]`); await wait(() => !q('[data-fm="body"]').disabled && q('[data-fm="status"]').textContent.includes('Connected')); await tick(); }
  async function send(body) { set('[data-fm="body"]', body); q('[data-fm="compose"]').requestSubmit(); await tick(); }
  try {
    await remount({});
    await wait(() => q('[data-fm="status"]').textContent === 'Messenger unavailable');
    assert(q('[data-fm="error"]').textContent.includes('authenticated'), 'Explicit disconnected bridge');
    assert(!qa('[data-conversation]').length && q('[data-fm="send"]').disabled, 'No fabricated records or sends');
    instance.destroy(); assert(!q('.farm-messenger'), 'Destroy removes surface');
    passed.push('unavailable bridge, honest empty state, no fake staff, teardown');

    await remount(); await selectFarm(); await selectThread();
    assert(q('.fm-message-body').textContent.includes('<img'), 'Message rendered verbatim');
    assert(!q('.fm-history img') && !window.injected, 'No HTML execution');
    assert(q('.fm-message-meta').textContent.includes('Fixture worker'), 'Real member author');
    assert(q('[aria-label="2 unread messages"]'), 'Unread from service');
    assert(qa('textarea,select,input').every(node => node.labels.length), 'Every input labeled');
    set('[data-fm="search"]', 'no result'); assert(!q('[data-conversation]'), 'Search filters'); set('[data-fm="search"]', '');
    await click('[data-filter="department"]'); equal(qa('[data-conversation]').map(node => node.dataset.conversation), ['c2'], 'Department filter'); await click('[data-filter="all"]');
    assert(q('.fm-quicklinks').textContent.includes('Timekeeping') && q('.fm-quicklinks').textContent.includes('Not connected'), 'Capability-only resources');
    passed.push('safe text, author identities, unread, labels, search, department filter, capability honesty');

    set('[data-fm="body"]', 'Keep my draft'); await selectThread('c2'); assert(q('[data-fm="body"]').value === '', 'Draft scoped to thread');
    await selectThread(); assert(q('[data-fm="body"]').value === 'Keep my draft', 'Draft restored');
    await selectFarm('f2'); await selectThread(); assert(q('[data-fm="body"]').value === '', 'Draft scoped to farm');
    await selectFarm(); await selectThread(); assert(q('[data-fm="body"]').value === 'Keep my draft', 'First farm draft restored');
    passed.push('per-farm and per-conversation in-memory drafts');

    const delayed = deferred(); handlers['message.list'] = p => p.conversationId === 'c1' ? delayed.promise : ok({ items: [] });
    await click('[data-conversation="c1"]'); await selectThread('c2'); delayed.resolve(ok({ items: [{ id: 'late', text: 'Wrong thread private text', sequence: 8 }] })); await tick(); await tick();
    assert(!q('.fm-history').textContent.includes('Wrong thread'), 'Stale thread cannot cross selection');
    delete handlers['message.list']; await selectThread();
    const delayedFarm = deferred(); handlers['conversation.list'] = p => p.farmId === 'f1' ? delayedFarm.promise : ok({ items: [{ id: 'f2-thread', title: 'Second farm', kind: 'group' }] });
    set('[data-fm="farm"]', 'f1'); set('[data-fm="farm"]', 'f2'); await wait(() => q('[data-conversation="f2-thread"]'));
    delayedFarm.resolve(ok({ items: [{ id: 'private', title: 'Wrong farm private title' }] })); await tick(); await tick(); assert(!q('[data-conversation="private"]'), 'Stale directory cannot cross farms');
    passed.push('late read responses isolated by farm and conversation generation');

    await remount(); await selectFarm(); await selectThread();
    let failSend = true; handlers['message.send'] = p => failSend ? Promise.reject(new Error('Fixture lost response')) : ok({ id: 'accepted' });
    await send('Ambiguous delivery'); await wait(() => q('[data-retry]'));
    const first = calls.filter(call => call.action === 'message.send')[0];
    equal(Object.keys(first.payload).sort(), ['conversationId', 'farmId', 'requestId', 'text'], 'Only human send payload');
    assert(q('[data-fm="body"]').value === 'Ambiguous delivery', 'Failed draft retained');
    assert(q('[data-fm="outbox"]').textContent.includes('may already'), 'Ambiguity explained');
    failSend = false; await click('[data-retry]'); await wait(() => q('[data-fm="outbox"]').textContent.includes('Server accepted'));
    const sends = calls.filter(call => call.action === 'message.send'); equal(sends[0].payload, sends[1].payload, 'Exact retry id and content');
    assert(!q('[data-fm="outbox"]').textContent.includes('Delivered'), 'Not an invented delivery receipt');
    assert(!q('[data-fm="body"]').value, 'Accepted matching draft cleared');
    passed.push('ambiguous-send retention, stable idempotency retries, actual server acceptance not delivery');

    const pending = deferred(); handlers['message.send'] = () => pending.promise;
    await send('Delayed first draft'); set('[data-fm="body"]', 'Replacement draft'); await selectThread('c2');
    pending.resolve(ok({ id: 'accepted2' })); await tick(); await tick(); await selectThread();
    assert(q('[data-fm="body"]').value === 'Replacement draft', 'Older outcome preserves newer draft');
    assert(q('[data-fm="outbox"]').textContent.includes('Server accepted'), 'Navigation does not discard send outcome');
    const count = calls.filter(call => call.action === 'message.send').length; set('[data-fm="body"]', 'x'.repeat(5001)); q('[data-fm="compose"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick();
    assert(calls.filter(call => call.action === 'message.send').length === count, 'Programmatic length bound');
    passed.push('pending-send navigation, newer draft preservation, input bounds');

    await remount(); await selectFarm(); await click('[data-fm="new"]');
    assert(q('[role="dialog"]') && q('.fm-sidebar').inert, 'Accessible modal excludes background');
    assert(!q('[role="dialog"]').textContent.includes('Software participant. Select explicitly.'), 'No fabricated Crowe Logic member');
    q('[name="memberIds"]').checked = true; q('[name="memberIds"]').dispatchEvent(new Event('change', { bubbles: true }));
    handlers['conversation.create'] = () => bad('Fixture disconnect');
    q('.fm-create-form').requestSubmit(); await wait(() => q('.fm-create-form [role="alert"]').textContent.includes('not confirmed'));
    q('.fm-create-form').requestSubmit(); await tick();
    const creates = calls.filter(call => call.action === 'conversation.create'); assert(creates.length === 2, 'Creation retry called'); equal(creates[0].payload, creates[1].payload, 'Stable creation intent');
    equal(creates[0].payload.participantIds, ['worker'], 'Explicit human participant'); assert(!('memberIds' in creates[0].payload), 'Backend create contract');
    q('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert(!q('[role="dialog"]') && !q('.fm-sidebar').inert, 'Escape closes and restores background');
    await click('[data-fm="new"]'); assert(q('[name="memberIds"]').checked, 'Cancelled create draft retained');
    set('[name="kind"]', 'department'); set('[name="title"]', 'Packing alerts'); set('[name="departmentId"]', 'd1');
    q('.fm-create-form').requestSubmit(); await tick();
    const departmentPayload = calls.filter(call => call.action === 'conversation.create').at(-1).payload;
    assert(departmentPayload.departmentId === 'd1' && !('participantIds' in departmentPayload), 'Dynamic department access without hardcoded participants');
    q('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    passed.push('create modal, explicit participants, department contract, exact create retries, retained create drafts');

    await selectThread(); handlers['message.list'] = () => bad('Fixture unavailable');
    await click('[data-fm="refresh"]'); set('[data-fm="body"]', 'Offline retained draft'); assert(q('[data-fm="send"]').disabled && q('[data-fm="body"]').value === 'Offline retained draft', 'Offline typing but no blind send');
    delete handlers['message.list']; await click('[data-fm="refresh"]'); await wait(() => !q('[data-fm="send"]').disabled);
    assert(q('[data-fm="body"]').value === 'Offline retained draft', 'Reconnect preserves draft');
    passed.push('disconnected thread retains local draft and reconnect does not erase it');

    const late = deferred(); handlers['message.send'] = () => late.promise; await send('Destroy during send'); const before = calls.length;
    instance.destroy(); late.resolve(ok({ id: 'late' })); await tick(); await tick();
    assert(!q('.farm-messenger') && calls.length === before, 'Destroy cancels waits and prevents follow-up requests');
    await remount(); await selectFarm(); await selectThread(); assert(!q('[data-fm="body"]').value, 'Fresh account mount cannot access old draft');
    passed.push('destroy during send, no late rendering or follow-up, no cross-account persistence');

    handlers['message.list'] = p => p.afterSequence === 0 ? ok({ items: Array.from({ length: 200 }, (_, i) => ({ id: 'p' + i, sequence: i + 1, text: 'Pagination fixture ' + i, authorId: 'worker' })), hasMore: true }) : ok({ items: [{ id: 'last', sequence: 201, text: 'Last page fixture', authorId: 'worker' }], hasMore: false });
    await selectThread('c2'); await wait(() => qa('[data-message]').length === 200);
    assert(!q('[data-fm="more"]').hidden, 'Pagination exposes newer messages'); await click('[data-fm="more"]'); await wait(() => qa('[data-message]').length === 201);
    assert(q('[data-fm="more"]').hidden, 'Final page completes');
    assert(calls.some(call => call.action === 'message.list' && call.payload.afterSequence === 200), 'Sequence pagination');
    passed.push('sequence pagination preserves history and offers all returned messages');
    delete handlers['message.list']; await selectThread();

    let selectionEvents = [];
    instance.destroy();
    instance = FarmMessenger.mount(q('#host'), bridge, { onFarmChanged: value => selectionEvents.push(value) }); window.messengerTest = instance;
    await tick(); await tick(); await selectFarm(); await selectThread();
    equal(instance.currentSelection(), { farmId: 'f1', currentMemberId: 'self', role: 'owner' }, 'Public farm selection');
    equal(selectionEvents.at(-1), instance.currentSelection(), 'Selection callback');
    set('[data-fm="body"]', 'Tab retained draft'); instance.deactivate(); assert(q('.farm-messenger').hidden, 'Deactivate hides content');
    const originalFocus = document.hasFocus; const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    document.hasFocus = () => true; Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const readCount = () => calls.filter(call => call.action === 'message.read').length;
    const beforeRead = readCount(); window.dispatchEvent(new Event('focus')); await tick(); assert(readCount() === beforeRead, 'Inactive tab never marks messages read');
    instance.open(); await tick(); await tick(); assert(!q('.farm-messenger').hidden && q('[data-fm="body"]').value === 'Tab retained draft', 'Open restores draft');
    q('[data-fm="thread"]').scrollTop = q('[data-fm="thread"]').scrollHeight;
    window.dispatchEvent(new Event('focus')); await wait(() => readCount() > beforeRead);
    const read = calls.filter(call => call.action === 'message.read').at(-1).payload;
    assert(read.requestId && read.sequence === 1, 'Own-read mutation request ID and loaded sequence');
    assert(!q('.fm-history').textContent.includes('Read by'), 'Own cursor does not become recipient receipt');
    document.hasFocus = originalFocus; if (visibility) Object.defineProperty(document, 'visibilityState', visibility); else delete document.visibilityState;
    instance.destroy(); equal(selectionEvents.at(-1), null, 'Destroy revokes scope callback'); assert(instance.currentSelection() === null, 'Destroyed selection not exposed');
    passed.push('selection callback, tab deactivation/resume, retained drafts, own-read scope and teardown');

    await remount(); farms = [];
    await click('[data-fm="refresh"]'); await wait(() => !q('[data-fm="farm-create"]').hidden);
    assert(!calls.some(call => call.action === 'farm.create'), 'No automatic farm creation');
    handlers['farm.create'] = () => bad('Fixture create uncertain');
    set('[data-fm="farm-create"] input', 'New fixture farm'); q('[data-fm="farm-create"]').requestSubmit(); await tick(); await tick();
    q('[data-fm="farm-create"]').requestSubmit(); await tick(); await tick();
    const farmCreates = calls.filter(call => call.action === 'farm.create'); equal(farmCreates[0].payload, farmCreates[1].payload, 'Stable explicit farm retry');
    assert(q('[data-fm="farm-create"]').textContent.includes('not confirmed'), 'Farm ambiguity retained');
    passed.push('empty account explicit farm creation only, retained intent and idempotent retry');

    await remount(); instance.destroy();
    const scoped = [];
    window.FarmWorkforce = window.FarmAwareness = { mount(container, _api, scope) {
      const record = { ...scope, destroyed: false, hidden: false }; scoped.push(record); container.textContent = 'Fixture tool';
      return { open() { record.hidden = false; }, deactivate() { record.hidden = true; }, destroy() { record.destroyed = true; container.replaceChildren(); } };
    } };
    instance = FarmTeam.mount(q('#host'), bridge); await tick(); await tick(); await selectFarm(); await selectThread();
    set('[data-fm="body"]', 'Wrapper tab draft'); await click('[data-team-tab="hours"]');
    assert(q('.farm-messenger').hidden && scoped[0].farmId === 'f1', 'Wrapper scopes hours and deactivates Messenger');
    await click('[data-team-tab="knowledge"]'); assert(scoped[0].hidden && scoped[1].farmId === 'f1', 'Wrapper deactivates hours for knowledge');
    await click('[data-team-tab="messages"]'); assert(q('[data-fm="body"]').value === 'Wrapper tab draft' && !q('.farm-messenger').hidden, 'Wrapper restores Messenger draft');
    await selectFarm('f2'); assert(scoped.every(row => row.destroyed), 'Farm change destroys old scoped tools');
    await click('[data-team-tab="hours"]'); assert(scoped.at(-1).farmId === 'f2', 'New farm gets fresh tool scope');
    instance.deactivate(); assert(scoped.at(-1).hidden, 'Wrapper deactivation reaches tool');
    instance.destroy(); assert(!q('.farm-team') && scoped.at(-1).destroyed, 'Wrapper destroy clears account surfaces');
    delete window.FarmWorkforce; delete window.FarmAwareness;
    passed.push('real FarmTeam wrapper lifecycle, shared farm scope, preserved drafts, no old scoped tools');

    await remount(); await selectFarm(); await selectThread();
    return { passed };
  } catch (err) { return { passed, error: err.stack }; }
}
