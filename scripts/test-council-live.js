#!/usr/bin/env node
// Real Electron renderer, preload, IPC, council, persistence and file executor.
// Only model inference is stubbed. The test profile never touches live sessions.
const {app,BrowserWindow,safeStorage} = require('electron');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.join(__dirname,'..');
fs.mkdirSync(path.join(__dirname, '../.council-test'), { recursive: true });
const base=fs.mkdtempSync(path.join(root,'.council-test/live-'));
const profile=path.join(base,'profile'),workspace=path.join(base,'workspace');
fs.mkdirSync(profile);fs.mkdirSync(workspace);
app.setPath('userData',profile);app.setPath('sessionData',profile);
fs.writeFileSync(path.join(workspace,'example.txt'),'before');
fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({cwd:workspace,telemetry:false,onboarded:true,autonomy:'edit'}));
const models=['council-alpha','council-beta','council-gamma'].map(id=>({id,name:id,engine:id,available:true,min_plan:'free'}));
const calls=[];
global.fetch=async(url,init={})=>{
 const respond=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 if(String(url).includes('/api/gateway/catalog'))return respond({models});
 if(!String(url).includes('/api/gateway/chat'))return respond({});
 const p=JSON.parse(init.body);calls.push(p);
 const sys=p.messages[0]?.content||'';
 let result;
 if(sys.startsWith('Propose the next'))result={kind:'propose',summary:'Replace the fixture with the approved word.',changes:[{path:'example.txt',content:'after'}]};
 else if(sys.startsWith('Act as a safety'))result={decision:'allow',reason:'Only the explicitly selected text file changes.'};
 else if(sys.startsWith('Independently'))result={decision:'approve',reason:'Compared the approved replacement with the selected file evidence. No runtime test is claimed.'};
 else return respond({content:'Message received by '+p.model,model:p.model,usage:{prompt_tokens:5,completion_tokens:5}});
 await new Promise(r=>setTimeout(r,75));
 return respond({content:JSON.stringify(result),model:p.model,usage:{prompt_tokens:30,completion_tokens:30}});
};
const {shutdownNativeResources}=require('../main');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let passed=0;
async function wait(fn){for(let i=0;i<100;i++){const x=await fn();if(x)return x;await sleep(100);}throw new Error('Timed out waiting for UI/workflow.');}
app.whenReady().then(async()=>{
 try{
  await sleep(800);const win=BrowserWindow.getAllWindows()[0];assert(win);
  if(win.webContents.isLoading())await new Promise(r=>win.webContents.once('did-finish-load',r));
  const js=code=>win.webContents.executeJavaScript(code);
  const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  const fake=[b64({alg:'none'}),b64({email:'council-test@example.com',tier:'pro',exp:Math.floor(Date.now()/1000)+3600}),'fixture'].join('.');
  const auth=JSON.stringify({token:fake,refreshToken:''});
  fs.writeFileSync(path.join(profile,'auth.bin'),safeStorage.isEncryptionAvailable()?safeStorage.encryptString(auth):auth);
  await sleep(600);
  await js('addPanel("room").then(() => true)');
  await wait(()=>js('document.querySelectorAll(".msg-contact[data-id^=model-]").length===3'));
  await js('document.querySelectorAll(".msg-contact[data-id^=model-]").forEach(b=>b.click());document.querySelector(".rc-open").click()');
  const roomId=await wait(()=>js('panels.find(p=>p.type==="room"&&p.roomId)?.roomId'));
  console.log('PASS model contacts create a group through the live UI');passed++;
  const direct=await js(`window.crowe.rooms.say(${JSON.stringify(roomId)},"@room hello")`);
  assert.equal(direct.ran.filter(r=>r.ok).length,3);console.log('PASS group messaging reaches all three pinned models');passed++;
  await js('document.querySelector(".room-council").click()');
  await js(`(() => {const f=document.querySelector('.council-form');f.elements.goal.value='Correct the fixture';f.elements.mode.value='files';f.elements.mode.dispatchEvent(new Event('change'));f.elements.files.value='example.txt';f.elements.maxSteps.value='1';f.elements.maxCalls.value='8';f.elements.consent.checked=true;f.requestSubmit();})()`);
  const finished=await wait(async()=>{const out=await js(`window.crowe.rooms.councilState(${JSON.stringify(roomId)})`);return ['completed','escalated'].includes(out.council?.status)?out:null;});
  assert.equal(finished.council.status,'completed',finished.council.reason);
  assert.equal(fs.readFileSync(path.join(workspace,'example.txt'),'utf8'),'after');
  assert.equal(finished.council.proposals[0].votes.length,2);
  assert(calls.filter(p=>p.messages[0]?.content.startsWith('Independently')).every(p=>!p.tools?.length));
  console.log('PASS UI grant -> safety -> independent votes -> real scoped write -> verification');passed++;
  await wait(()=>js('document.querySelectorAll(".council-votes li").length===2'));
  await wait(()=>js('document.querySelector(".council-ledger").textContent.includes("verified")'));
  const picture=await win.webContents.capturePage();fs.writeFileSync(path.join(base,'desktop.png'),picture.toPNG());
  console.log('PASS branded council cards show votes and receipts');passed++;
  await js('document.querySelector(".council-revoke").click()');
  await wait(async()=> (await js(`window.crowe.rooms.councilState(${JSON.stringify(roomId)})`)).council.status==='revoked');
  console.log('PASS revoke authority through the live UI');passed++;
  win.setSize(430,880);await sleep(400);
  assert(await js('document.querySelector(".council-form").getBoundingClientRect().width>100'));
  fs.writeFileSync(path.join(base,'phone-width.png'),(await win.webContents.capturePage()).toPNG());
  console.log('PASS responsive council surface at phone width');passed++;
  console.log(`council-live: ${passed} checks passed; screenshots in ${path.relative(root,base)}`);
  shutdownNativeResources();app.exit(0);
 }catch(e){console.error(e.stack);shutdownNativeResources();app.exit(1);}
});
