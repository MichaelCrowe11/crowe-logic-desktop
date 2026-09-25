'use strict';
// Run with Electron for an actual DOM; no app, models or external network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-import-ui-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const isolated = session.fromPartition('import-ui-test', { cache: false });
  isolated.webRequest.onBeforeRequest((details, answer) => answer({ cancel: !details.url.startsWith('data:') }));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: isolated } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await win.loadURL('data:text/html,<meta charset=utf-8><main id="imports"></main>');
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '../renderer/farm-imports.js'), 'utf8'));
    const results = await win.webContents.executeJavaScript(`(async () => {
      const calls = [], stage = { id:'source-1',ref:'ref-1',name:'<img src=x onerror=alert(1)>.csv',sourceDigest:'abc',byteLength:12,parseStatus:'parsed',elementCount:1,revision:0,state:'parsed_source',pageCount:null,warnings:[],candidates:[],note:'',receipt:null };
      const api = { request: async (action,payload) => {
        calls.push({action,payload});
        if(action==='status') return {ok:true,data:{reviewerMode:'self_attributed',notice:'Local staging only',ocrReason:'OCR unavailable. Nothing sent.'}};
        if(action==='list') return {ok:true,data:{imports:[]}};
        if(action==='choose') return {ok:true,data:{...stage}};
        if(action==='preview') return {ok:true,data:{...stage,elements:[{id:'e1',raw:'<script>window.pwned=true</script>',value:'TRUE',valueType:'text',locator:{row:1,column:1,page:null},uncertainty:['verify']}],nextOffset:null}};
        if(action==='revise') {stage.revision++;stage.state='draft_revision';stage.note=payload.note;stage.candidates=[{kind:payload.selections[0].kind,fields:payload.selections[0].fields.map(f=>({...f,sourceRef:{elementId:f.elementId}}))}];return {ok:true,data:{...stage}};}
        if(action==='review') {stage.revision++;stage.state='reviewed_for_staging';stage.receipt={receiptDigest:'exact',ledgerWriteAuthorized:false};stage.reviewer={name:payload.reviewer,attribution:'self_attributed'};return {ok:true,data:{...stage}};}
        return {ok:true,data:{status:'cancelled'}};
      }};
      const wait=()=>new Promise(r=>setTimeout(r,20)); const root=document.getElementById('imports');const mounted=window.FarmImports.mount(root,api); await wait();
      root.querySelector('[data-imports=choose]').click();await wait();
      const escaped=!root.querySelector('img,script')&&!window.pwned&&root.textContent.includes('<script>window.pwned=true</script>');
      const check=root.querySelector('tbody input[type=checkbox]');check.checked=true;check.dispatchEvent(new Event('change'));
      root.querySelector('[data-imports=revise]').click();await wait();
      const reviewer=root.querySelector('input[maxlength="200"]');reviewer.value='Owner';
      const ack=root.querySelector('.farm-imports-check input');ack.checked=true;
      root.querySelector('[data-imports=review]').click();await wait();
      const receipt=root.textContent.includes('Reviewed for staging only. Not promoted.')&&root.textContent.includes('exact');
      const noPromotion=!calls.some(c=>['promote','analyze'].includes(c.action));
      const revision=calls.find(c=>c.action==='revise'); const reviewed=calls.find(c=>c.action==='review');
      mounted.destroy();await wait();
      return {escaped,receipt,noPromotion,revision,reviewed,destroyed:root.children.length===0,cancelled:calls.some(c=>c.action==='cancel')};
    })()`);
    assert(results.escaped); assert(results.receipt); assert(results.noPromotion); assert(results.destroyed); assert(results.cancelled); assert.equal(results.revision.payload.selections[0].kind, 'document_draft'); assert.equal(results.revision.payload.selections[0].fields[0].elementId, 'e1'); assert.equal(results.reviewed.payload.expectedRevision, 1); assert.equal(results.reviewed.payload.acknowledgedUncertainty, true);
    console.log('farm import UI: actual isolated DOM choose/preview/select/revise/review/destroy passed; source HTML inert; no promotion/model calls');
  } finally { win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.quit(); }
}).catch(error => { console.error(error); process.exitCode = 1; app.quit(); });
