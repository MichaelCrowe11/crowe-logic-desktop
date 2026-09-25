// Offline real-DOM privacy and camera checks. All HTTP(S) is blocked.
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-mobile-privacy-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'crowe-mobile-privacy-evidence-'));
app.whenReady().then(async () => {
  let win;
  try {
    require('../mobile/scripts/build-www.js');
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, cb) => cb({ cancel: true }));
    win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false });
    // Seed only this temporary profile, before any application script executes.
    // Wrap ordinary reads to detect startup/journal access, while preserving
    // exact malformed and empty legacy strings for comparisons across reloads.
    const legacy = {
      'crowe:grow:blocks': '[{"code":"SYNTHETIC-LOT","stage":"fruiting","unknown":{"keep":true}}]',
      'crowe:grow:flushes': '', 'crowe:grow:contam': '{malformed raw value',
      'crowe:grow:env': '[]', 'crowe:grow:strains': 'null',
      'crowe:grow:recipes': '  []\n', 'crowe:grow:log': '[{"entry":"PRIVATE SYNTHETIC LEGACY NOTE"}]',
      'crowe:camera-roll': '[{"thumb":"data:image/jpeg;base64,eA==","unknown":"preserve"}]',
    };
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const legacy = ${JSON.stringify(legacy)};
      const rawGet = Storage.prototype.getItem;
      if (!rawGet.call(localStorage, 'synthetic-seeded')) {
        for (const [key,value] of Object.entries(legacy)) localStorage.setItem(key,value);
        localStorage.setItem('crowe-space','cultivation');
        localStorage.setItem('crowe-spaces',JSON.stringify(['chat','projects','cultivation','farm']));
        localStorage.setItem('crowe-pane','camera');
        localStorage.setItem('synthetic-seeded','1');
      }
      window.__legacyReads = [];
      Storage.prototype.getItem = function(key) {
        if (Object.hasOwn(legacy,key)) __legacyReads.push(key);
        return rawGet.call(this,key);
      };
      window.__legacyUnchanged = () => Object.entries(legacy).every(([key,value]) => rawGet.call(localStorage,key) === value);
    })();` });
    await win.loadFile(path.join(root, 'mobile/www/index.html'));
    const evaluate = code => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
    const initial = await evaluate(`await new Promise(r => setTimeout(r, 150)); return { open: document.querySelector('#m-notice').classList.contains('open'), version: (await crowe.getConfig()).dataNoticeVersion };`);
    assert.equal(initial.open, true); assert.equal(initial.version, 3);
    const boundary = await evaluate(`return {pane:document.body.dataset.pane,space:document.body.dataset.space,reads:__legacyReads,unchanged:__legacyUnchanged(),panes:!!document.querySelector('#m-home-pane,#m-camera-pane')};`);
    assert.deepEqual(boundary, {pane:'agent',space:'chat',reads:[],unchanged:true,panes:false});
    await evaluate(`const style=document.createElement('style'); style.textContent='*,*::before,*::after{animation:none!important;transition:none!important} #launch{display:none!important}'; document.head.appendChild(style);`);
    await evaluate(`await new Promise(r=>setTimeout(r,250));`);
    fs.writeFileSync(path.join(evidence, 'notice.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate(`document.querySelector('#m-notice-allow').click(); await new Promise(r => setTimeout(r, 50));`);
    assert.equal(await evaluate(`return await croweConsent.has('data');`), true);
    await evaluate(`
      window.__storageSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key === 'crowe:data-consent-v2') throw new Error('synthetic storage refusal'); return __storageSet.call(this,key,value); };
      try { await croweConsent.withdraw(); } catch {}
      document.querySelector('#settings-btn').click();
      await new Promise(r=>setTimeout(r,100));
      document.querySelector('.m-data').scrollIntoView({block:'center'});
    `);
    assert.equal(await evaluate(`return document.querySelector('#m-data-withdraw').disabled;`), false);
    fs.writeFileSync(path.join(evidence, 'withdrawal-retry-synthetic.png'), (await win.webContents.capturePage()).toPNG());
    console.log('Screenshots (offline UI; withdrawal failure is synthetic): ' + evidence);
    await evaluate(`Storage.prototype.setItem=__storageSet; await croweConsent.withdraw();`);
    assert.equal(await evaluate(`return await croweConsent.has('data');`), false);
    console.log('ok real notice appears, allowance persists, withdrawal denies');

    const photoOnly = await evaluate(`
      const oldAuth=crowe.auth.status, run=crowe.agent.run;
      let called=0, sentText='', refused;
      crowe.auth.status=async()=>({user:{email:'synthetic@example.invalid',tier:'free'}});
      crowe.agent.run=async (...args)=>{ called++; sentText=args[0].at(-1).content; refused=await run(...args); return refused; };
      const canvas=document.createElement('canvas'); canvas.width=canvas.height=16;
      canvas.getContext('2d').fillRect(0,0,16,16);
      crowePhone.addImage('synthetic-object.png',canvas.toDataURL('image/png'));
      document.getElementById('cfg-cancel').click();
      document.getElementById('input').value='';
      document.getElementById('send').click();
      const deadline=Date.now()+3000;
      while (!refused && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
      crowe.agent.run=run; crowe.auth.status=oldAuth;
      return {called,sentText,denied:refused?.done===false,notice:document.getElementById('m-notice').classList.contains('open'),images:crowePhone.images().length};
    `);
    assert.equal(photoOnly.called,1); assert.match(photoOnly.sentText,/Describe this image/);
    assert.equal(photoOnly.denied,true); assert.equal(photoOnly.notice,true); assert.equal(photoOnly.images,1);
    console.log('ok photo-only Send reaches the actual bridge and still requires consent, preserving its attachment');

    // Register the actual UI event handlers against a synthetic stream, with
    // no gateway or native access. This captures closures, not reimplementations.
    await evaluate(`window.__cameraEvents = []; crowe.agent.onEvent = cb => { __cameraEvents.push(cb); return () => {}; };`);
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'mobile/src/mobile-ui.js'), 'utf8'));
    const camera = await evaluate(`
      const callbacks = __cameraEvents.filter(cb => /photoTurn|scanRegions/.test(String(cb)));
      if (callbacks.length !== 1) throw new Error('camera listener capture changed');
      let legacyAccesses = 0;
      crowe.grow.list = async () => { legacyAccesses++; return []; };
      crowe.grow.save = async () => { legacyAccesses++; return {ok:true}; };
      crowe.camera.add = async () => { legacyAccesses++; return {ok:true}; };
      const fixture = document.createElement('div'); fixture.id = 'privacy-camera-fixture';
      fixture.innerHTML = '<div class="msg user"><div class="body"></div></div><div class="msg assistant"><div class="body"></div></div>';
      document.body.appendChild(fixture);
      const emit = async ev => { for (const cb of callbacks) await cb({ agentId: 'main', runId: 10, ...ev }); };
      const canvas=document.createElement('canvas'); canvas.width=canvas.height=16;
      canvas.getContext('2d').fillRect(0,0,16,16);
      const image=canvas.toDataURL('image/png');
      await emit({type: 'photos', thumbs: [image]});
      const photo=fixture.querySelector('.m-scan-photo'); await photo.decode();
      await emit({type: 'assistant', text: 'I will inspect the image first.'});
      const afterPreamble = { log: fixture.querySelectorAll('.m-log-it').length, done: fixture.querySelectorAll('.m-scan-done').length };
      await emit({type: 'final', agentId: 'other'});
      await emit({type: 'final', runId: 9});
      const afterOther = fixture.querySelectorAll('.m-scan-done').length;
      await emit({type: 'vision_regions', regions: [{x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: 'Power connector'}]});
      await emit({type: 'assistant', text: 'The power connector is loose.'});
      await emit({type: 'final', success: true, finding: 'The power connector is loose.'});
      return { afterPreamble, afterOther, done: fixture.querySelectorAll('.m-scan-done').length,
        logActions: fixture.querySelectorAll('.m-log-it').length, legacyAccesses,
        region: fixture.querySelector('.m-scan-label').textContent,
        classified: Boolean(fixture.querySelector('.m-r-myc, .m-r-gold, .m-r-bad')),
        decoded: photo.naturalWidth === 16, tiles: fixture.querySelectorAll('.m-scan-tile canvas').length };
    `);
    assert.deepEqual(camera.afterPreamble, {log: 0, done: 0}); assert.equal(camera.afterOther, 0); assert.equal(camera.done, 1);
    assert.equal(camera.logActions, 0); assert.equal(camera.legacyAccesses, 0);
    assert.match(camera.region, /Power connector/); assert.equal(camera.classified, false);
    assert.equal(camera.decoded, true); assert.equal(camera.tiles, 1);
    console.log('ok general photo waits for final finding; late regions stay active; unrelated events ignored; no grow reads or writes');
    assert.deepEqual(await evaluate(`return {reads:__legacyReads,unchanged:__legacyUnchanged()};`), {reads:[],unchanged:true});
    // Reload the real shell: no journal reads, migration or resurrection of a
    // stale grow route may be hidden behind the first-run transition.
    await win.loadFile(path.join(root, 'mobile/www/index.html'));
    await evaluate(`await new Promise(r=>setTimeout(r,200));`);
    assert.deepEqual(await evaluate(`return {pane:document.body.dataset.pane,space:document.body.dataset.space,reads:__legacyReads,unchanged:__legacyUnchanged()};`), {pane:'agent',space:'chat',reads:[],unchanged:true});
    await evaluate(`document.getElementById('m-notice-later')?.click(); const style=document.createElement('style'); style.textContent='*,*::before,*::after{animation:none!important;transition:none!important} #launch{display:none!important}'; document.head.appendChild(style);`);
    for (const theme of ['light','dark']) {
      await evaluate(`document.body.classList.toggle('dark',${theme === 'dark'}); await new Promise(r=>setTimeout(r,100));`);
      fs.writeFileSync(path.join(evidence, `chat-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    }
    console.log('ok synthetic legacy strings unchanged through startup, general photo events and restart; Chat screenshots captured');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    if (win) win.destroy();
    fs.rmSync(profile, { recursive: true, force: true });
    // Electron app.quit() can exit zero despite process.exitCode. Assertions
    // must fail the command, not merely print an error in otherwise green CI.
    app.exit(process.exitCode || 0);
  }
});
