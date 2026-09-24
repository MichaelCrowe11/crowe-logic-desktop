#!/usr/bin/env node
// Offline consent integration checks. No device, account, or network access.
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const root = path.resolve(__dirname, "..");
const harness = fs.readFileSync(path.join(__dirname, "test-mobile-bridge.js"), "utf8").split("// Sequential and awaited:")[0].replace(/^#![^\n]*\n/, "");
const { load, version } = new Function("require", "__dirname", harness + "\nreturn {load: loadMobileSurface, version: NOTICE_VERSION};")(require, __dirname);
const record = version => ({ version, at: "2026-09-23T00:00:00.000Z" });
(async () => {
  let calls = 0;
  const bridge = load(async url => { if (String(url).includes("/api/gateway/chat")) calls++; return new Response('{}'); }, null, { consent: false });
  const phone = load.lastWindow.crowePhone;
  await bridge.setConfig({ token: "synthetic", dataConsent: record(version) });
  assert.equal((await bridge.chat([])).code, "consent", "ordinary config cannot grant consent");
  for (const value of [record(version - 1), record(String(version)), { version, at: "invalid" }]) {
    await assert.rejects(phone.setConsent({ dataConsent: value }, phone.consentEpoch()));
  }
  await phone.setConsent({ dataConsent: record(version) }, phone.consentEpoch());
  await bridge.chat([]); assert.equal(calls, 1);
  const old = phone.consentEpoch();
  await phone.setConsent({ dataConsent: null });
  assert.equal((await bridge.chat([])).code, "consent");
  await assert.rejects(phone.setConsent({ dataConsent: record(version) }, old));
  await bridge.setConfig({ dataConsent: record(version), textPace: "reading" });
  assert.equal((await bridge.chat([])).code, "consent", "stale config cannot restore consent");
  console.log("ok consent grants, malformed/stale records, withdrawal, stale snapshot");

  const previousNotice = new Map([
    ['config', JSON.stringify({token:'synthetic'})],
    ['data-consent-v2', JSON.stringify({dataConsent:record(2),readAloudConsent:record(2)})],
  ]);
  let upgradedSends=0;
  const upgraded=load(async url=>{if(String(url).includes('/api/gateway/chat'))upgradedSends++;return new Response('{}');},
    {Plugins:{Preferences:{get:async({key})=>({value:previousNotice.get(key)||null}),set:async({key,value})=>previousNotice.set(key,value)}}},{consent:false});
  const upgradedPhone=load.lastWindow.crowePhone;
  assert.equal((await upgraded.getConfig()).dataNoticeVersion,3);
  assert.equal((await upgraded.getConfig()).featureNoticeVersion,2);
  assert.equal((await upgraded.getConfig()).readAloudConsent.version,2);
  assert.equal((await upgraded.chat([])).code,'consent');
  assert.equal((await upgraded.agent.run([{role:'user',content:'synthetic'}])).done,false);
  assert.equal(upgradedSends,0,'persisted v2 grant cannot send after v3 startup');
  await upgradedPhone.setConsent({dataConsent:record(3)},upgradedPhone.consentEpoch());
  await upgraded.chat([]); assert.equal(upgradedSends,1);
  assert.equal(JSON.parse(previousNotice.get('data-consent-v2')).dataConsent.version,3);
  console.log('ok persisted main v2 grant denied until fresh v3 allowance; feature v2 and storage key preserved');

  let fail = true, stored = null;
  const cap = { Plugins: { Preferences: {
    get: async () => ({ value: stored }),
    set: async ({ value }) => { if (fail) throw new Error("synthetic store refusal"); stored = value; },
  } } };
  const failed = load(async () => new Response('{}'), cap, { consent: false });
  const fp = load.lastWindow.crowePhone;
  await assert.rejects(fp.setConsent({ dataConsent: record(version) }, fp.consentEpoch()));
  assert.equal((await failed.chat([])).code, "consent");
  fail = false;
  await fp.setConsent({ dataConsent: record(version) }, fp.consentEpoch());
  fail = true;
  await assert.rejects(fp.setConsent({ dataConsent: null }), /before restarting/);
  assert.equal((await failed.chat([])).code, "consent", "failed withdrawal save still denies this runtime");
  console.log("ok failed grant denied; failed withdrawal persistence explicitly reported");

  // Actual vault.js + bridge, shared synthetic native stores across restart.
  const preferences = new Map(), keychain = new Map();
  let vaultRefuses = false, preferencesRefuse = false;
  const nativeStores = {
    isNativePlatform: () => true,
    Plugins: {
      Preferences: {
        get: async ({key}) => ({value: preferences.get(key) || null}),
        set: async ({key, value}) => { if (preferencesRefuse) throw new Error('synthetic Preferences refusal'); preferences.set(key, value); },
        remove: async ({key}) => preferences.delete(key),
      },
      CroweVault: {
        get: async ({key}) => { if (vaultRefuses) throw new Error('synthetic vault refusal'); return {value: keychain.get(key) || null}; },
        set: async ({key, value}) => { if (vaultRefuses) throw new Error('synthetic vault refusal'); keychain.set(key, value); },
        remove: async ({key}) => keychain.delete(key),
      },
    },
  };
  const boot = () => load(async () => new Response('{}'), nativeStores, {consent:false, vault:true});
  keychain.set('config', JSON.stringify({token:'synthetic', dataConsent:record(version)}));
  const legacy = boot();
  assert.equal((await legacy.chat([])).code, 'consent', 'legacy Keychain grants must not migrate');
  let authority = load.lastWindow.crowePhone;
  await authority.setConsent({dataConsent:record(version)}, authority.consentEpoch());
  assert.equal(authority.consentValid(authority.consentEpoch()), true);
  vaultRefuses = true;
  // Reproduce real vault fallback for unrelated settings, without using it as
  // consent authority. The older granted Keychain config remains intact.
  await legacy.setConfig({textPace:'brisk'});
  assert(preferences.has('config'));
  await authority.setConsent({dataConsent:null});
  vaultRefuses = false;
  const restarted = boot();
  assert.equal((await restarted.chat([])).code, 'consent', 'recovered Keychain cannot resurrect consent');
  assert.equal((await restarted.getConfig()).hasToken, true, 'vault sign-in preserved');
  authority = load.lastWindow.crowePhone;
  preferencesRefuse = true;
  await assert.rejects(authority.setConsent({dataConsent:record(version)}, authority.consentEpoch()));
  assert.equal((await restarted.chat([])).code, 'consent');
  preferencesRefuse = false;
  console.log('ok actual vault fallback/recovery cannot restore withdrawn consent; independent store failure denies grants');

  let release, entered;
  const inFetch = new Promise(resolve => entered = resolve);
  let nativeCalls = 0;
  const native = { CapacitorHttp: { request: async () => { nativeCalls++; return { status: 200, data: '{}' }; } } };
  const racing = load(async url => {
    if (!String(url).includes('/api/gateway/chat')) return new Response('{}');
    entered(); await new Promise(resolve => release = resolve); throw new TypeError('Failed to fetch');
  }, native, { consent: false });
  const rp = load.lastWindow.crowePhone;
  await racing.setConfig({ token: 'synthetic' });
  await rp.setConsent({ dataConsent: record(version) }, rp.consentEpoch());
  const result = racing.chat([]); await inFetch;
  await rp.setConsent({ dataConsent: null });
  await rp.setConsent({ dataConsent: record(version) }, rp.consentEpoch());
  release(); assert.equal((await result).code, 'consent'); assert.equal(nativeCalls, 0);
  console.log('ok withdrawn/reallowed operation cannot reach native fallback');

  // Exercise the actual read-aloud module with a synthetic DOM and service.
  async function speech({ missing = false, preferred = 'michael', revoke = false } = {}) {
    let sends = 0, local = 0, allowed = true, click;
    const button = { classList: { add() {}, remove() {} }, setAttribute() {}, set onclick(fn) { click = fn; } };
    const win = { addEventListener() {}, crowe: { getConfig: async () => ({ baseUrl: 'https://synthetic.invalid' }), auth: { status: async () => ({ user: {} }) } }, crowePhone: { accessToken: () => 'synthetic', consentEpoch: () => 0, consentValid: () => allowed } };
    if (!missing) win.croweConsent = { ask: async () => true };
    const fetch = async url => { sends++; if (url.endsWith('/voices')) { if (revoke) allowed = false; return { ok: true, json: async () => ({ voices: [{ voice: 'michael', allowed: true, configured: true }] }) }; } throw new Error('unexpected speech send'); };
    new Function('window', 'document', 'localStorage', 'fetch', 'speechSynthesis', 'SpeechSynthesisUtterance', fs.readFileSync(path.join(root, 'mobile/src/speak.js'), 'utf8'))(win, { getElementById: () => button, querySelectorAll: () => [{ innerText: 'synthetic reply' }] }, { getItem: () => preferred }, fetch, { speak: () => local++, speaking: false }, function() {});
    click(); for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
    return { sends, local };
  }
  assert.deepEqual(await speech({ missing: true }), { sends: 0, local: 1 });
  assert.deepEqual(await speech({ preferred: 'phone' }), { sends: 0, local: 1 });
  assert.deepEqual(await speech({ revoke: true }), { sends: 1, local: 0 });
  console.log('ok missing speech consent fails closed; phone voice preserved; revocation during voices blocks text');

  const ui = fs.readFileSync(path.join(root, 'mobile/src/mobile-ui.js'), 'utf8');
  const dictation = ui.slice(ui.indexOf('  const dictBtn ='), ui.indexOf('  const accountSection ='));
  async function dictate({ missing = false, revoke = false } = {}) {
    let starts = 0, allowed = true;
    const handlers = {};
    const button = { classList: {add() {}, remove() {}}, removeAttribute() {}, setAttribute() {} };
    const input = { value: '', dispatchEvent() {} };
    const win = { Capacitor: { isNativePlatform: () => true }, addEventListener() {}, crowePhone: { consentEpoch: () => 0, consentValid: () => allowed } };
    if (!missing) win.croweConsent = { ask: async () => true };
    const Speech = { addListener: (name, callback) => { handlers[name] = callback; }, stop: async () => {}, requestPermissions: async () => ({ speechRecognition: 'granted' }), available: async () => { if (revoke) allowed = false; return { available: true }; }, start: async () => { starts++; } };
    new Function('window', '$', 'Speech', dictation)(win, id => id === 'voice-input' ? button : id === 'input' ? input : null, Speech);
    await button.onclick();
    handlers.partialResults({ matches: ['synthetic dictation'] });
    return { starts, text: input.value };
  }
  assert.deepEqual(await dictate({ missing: true }), {starts: 0, text: ''});
  assert.deepEqual(await dictate({ revoke: true }), {starts: 0, text: ''});
  assert.deepEqual(await dictate(), {starts: 1, text: 'synthetic dictation'});
  console.log('ok dictation missing allowance and withdrawn permission callbacks cannot start or write text');

  for (const delayed of ['permissions', 'available']) {
    let epoch = 0, starts = 0, first = true, release, entered;
    const held = new Promise(resolve => entered = resolve);
    const handlers = {}, events = {};
    const button = {classList:{add(){},remove(){}},removeAttribute(){},setAttribute(){}};
    const input = {value:'',dispatchEvent(){}};
    const win = {Capacitor:{isNativePlatform:()=>true}, addEventListener:(name, cb)=>events[name]=cb,
      crowePhone:{consentEpoch:()=>epoch,consentValid:value=>value===epoch}, croweConsent:{ask:async()=>true}};
    const wait = async value => { if (!first) return value; first=false; entered(); await new Promise(resolve=>release=resolve); return value; };
    const Speech = {addListener:(name,cb)=>handlers[name]=cb,stop:async()=>{},start:async()=>{starts++;},
      requestPermissions:async()=>delayed==='permissions'?wait({speechRecognition:'granted'}):{speechRecognition:'granted'},
      available:async()=>delayed==='available'?wait({available:true}):{available:true}};
    new Function('window','$','Speech',dictation)(win,id=>id==='voice-input'?button:id==='input'?input:null,Speech);
    const oldAttempt=button.onclick(); await held;
    epoch++; events['crowe:consent-withdrawn']();
    await button.onclick(); assert.equal(starts,1,'newly allowed attempt starts once');
    release(); await oldAttempt;
    assert.equal(starts,1,`old ${delayed} callback cannot borrow the new attempt epoch`);
  }
  console.log('ok stale permission and availability attempts cannot start after withdraw/reallow/new click');

  // Execute the remaining production photo scan callback, not a grow-journal
  // mock. A terminal can stop the scan without claiming a completed finding.
  assert.doesNotMatch(ui, /crowe\.grow|crowe\.camera|photoTurn|cameraArmed|renderHome|renderCamera/);
  const scanStart = ui.indexOf('      let scanRunId;');
  const scanEnd = ui.indexOf('\n    }\n  }', scanStart);
  assert(scanStart > 0 && scanEnd > scanStart, 'production photo callback located');
  const scanSource = ui.slice(scanStart, scanEnd);
  function photoScan(events) {
    const state = { endings: [], regions: [], photos: 0, reading: 0 };
    let callback;
    const window = {crowe:{agent:{onEvent: cb => {callback=cb;}}}};
    const node = () => ({className:'', appendChild(){}});
    const document = {querySelectorAll:()=>[node()], createElement:node};
    new Function('window','document','scanRegions','scanReasoning','scanReading','endScan','beginScan',scanSource)(
      window, document, value=>state.regions.push(value), ()=>{}, ()=>state.reading++, how=>state.endings.push(how), ()=>state.photos++);
    for (const ev of events) callback({agentId:'main',...ev});
    return state;
  }
  const photos = runId => ({type:'photos',runId,thumbs:['data:image/jpeg;base64,eA==']});
  const assistant = (runId,text) => ({type:'assistant',runId,text});
  for (const note of ['turn budget reached','round limit','stopped','empty completion']) {
    assert.deepEqual(photoScan([photos(1),assistant(1,'I will inspect the image.'),{type:'final',runId:1,note}]).endings,['stopped']);
  }
  const generic = photoScan([photos(1),assistant(1,'Preamble'),
    {type:'final',runId:1,agentId:'other',success:true,finding:'wrong agent'},
    {type:'final',runId:0,success:true,finding:'wrong run'},
    {type:'vision_regions',runId:1,regions:[{label:'Power connector'}]},
    assistant(1,'The connector is loose.'),{type:'final',runId:1,success:true,finding:'The connector is loose.'}]);
  assert.equal(generic.photos,1); assert.equal(generic.regions.length,1); assert.deepEqual(generic.endings,['done']);
  assert.deepEqual(photoScan([photos(1),photos(2),{type:'final',runId:1,success:true,finding:'Old finding'},
    {type:'final',runId:2,success:true,finding:''}]).endings,['stopped']);
  console.log('ok general photo scan waits for completion, ignores stale events and has no grow-journal callback');

  // Actual inbox calls actual bridge addImage(name, dataUrl), not a permissive
  // one-argument mock. Collection does not initiate any gateway request.
  let share = JSON.stringify({at:Date.now(),image:'data:image/jpeg;base64,eA=='});
  const shareCap = {isNativePlatform:()=>true,Plugins:{CroweVault:{takeShared:async()=>{const value=share;share=null;return {value};}},App:{addListener(){}}}};
  load(async()=>new Response('{}'),shareCap,{consent:false});
  const sw = load.lastWindow;
  new Function('window','document','setTimeout',fs.readFileSync(path.join(root,'mobile/src/share-inbox.js'),'utf8'))(sw,{getElementById:()=>null,querySelectorAll:()=>[]},()=>{});
  await sw.croweShareInbox.collect(); assert.equal(sw.crowePhone.images().length,1);
  assert.equal(sw.crowePhone.images()[0].name,'shared-photo.jpg');
  await sw.croweShareInbox.collect(); assert.equal(sw.crowePhone.images().length,1);
  console.log('ok shared image attaches through real bridge exactly once');

  // Full notice module with a minimal synthetic DOM, backed by the real bridge.
  // A failed durable withdrawal must leave an actionable retry button.
  const noticeStore = new Map(); let denyWrite=false;
  const noticeBridge=load(async()=>new Response('{}'),{Plugins:{Preferences:{get:async({key})=>({value:noticeStore.get(key)||null}),set:async({key,value})=>{if(denyWrite)throw new Error('synthetic write failure');noticeStore.set(key,value);}}}},{consent:false});
  const nw=load.lastWindow; await nw.crowePhone.setConsent({dataConsent:record(version)},nw.crowePhone.consentEpoch());
  const elements=new Map();
  const element=()=>({classList:{add(){},remove(){},toggle(){}},setAttribute(){},appendChild(){},addEventListener(name,cb){this[name]=cb;}});
  const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  const document={body:element(),createElement:element,getElementById:get,querySelector:()=>null};
  get('key-provider-list').closest=()=>null;
  nw.addEventListener=()=>{}; nw.confirm=()=>true;
  new Function('window','document','setTimeout',fs.readFileSync(path.join(root,'mobile/src/data-notice.js'),'utf8'))(nw,document,fn=>fn());
  await new Promise(resolve=>setImmediate(resolve));
  denyWrite=true; await get('m-data-withdraw').click(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await noticeBridge.getConfig()).consentWithdrawalPending,true);
  assert.equal(get('m-data-withdraw').disabled,false);
  assert.match(get('m-data-state').textContent,/retry withdrawal/);
  denyWrite=false; await get('m-data-withdraw').click(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await noticeBridge.getConfig()).consentWithdrawalPending,false);
  assert.equal(get('m-data-withdraw').disabled,true);
  console.log('ok failed withdrawal keeps explicit retry state until a successful durable retry');
})().catch(error => { console.error(error); process.exitCode = 1; });
