#!/usr/bin/env node
// Starts a loopback dev server and drives the actual web and mobile payloads
// in Chromium. Only inference and authentication are fixtures, never production.
const {app,BrowserWindow,session}=require('electron');
const http=require('http'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.join(__dirname,'..');
fs.mkdirSync(path.join(__dirname, '../.council-test'), { recursive: true });
const proof=fs.mkdtempSync(path.join(root,'.council-test/browser-'));
app.setPath('userData',proof);
app.on('window-all-closed',()=>{});
const models=['model-alpha','model-beta','model-gamma'].map(id=>({id,engine:id,available:true,min_plan:'free'}));
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'};
const calls=[];
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 const json=body=>{res.writeHead(200,{'content-type':'application/json','access-control-allow-origin':'*'});res.end(JSON.stringify(body));};
 if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,POST,OPTIONS'});return res.end();}
 if(url.pathname==='/fixture-bootstrap.js'){
  const payload=Buffer.from(JSON.stringify({email:'browser-test@example.com',tier:'pro',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
  res.writeHead(200,{'content-type':'text/javascript'});
  return res.end(`localStorage.setItem('crowe.web.config',JSON.stringify({onboarded:true}));localStorage.setItem('crowe:config',JSON.stringify({token:'fixture.${payload}.fixture',onboarded:true,autonomy:'readonly'}));`);
 }
 if(url.pathname.endsWith('/whoami'))return json({email:'browser-test@example.com',tier:'pro'});
 if(url.pathname.endsWith('/models'))return json({data:models});
 if(url.pathname.endsWith('/catalog'))return json({models});
 if(url.pathname.endsWith('/chat/completions')||url.pathname.endsWith('/gateway/chat')){
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);calls.push(body);
  const prompt=body.messages[0]?.content||'';
  let text='Direct message from '+body.model;
  if(prompt.startsWith('Propose the next'))text=JSON.stringify({kind:'complete',summary:'Reviewed the objective and recorded a bounded recommendation.',changes:[]});
  else if(prompt.startsWith('Act as a safety'))text=JSON.stringify({decision:'allow',reason:'Advisory only; no external actions.'});
  else if(prompt.startsWith('Independently'))text=JSON.stringify({decision:'approve',reason:'The proposal stays within the advisory agreement.'});
  await new Promise(r=>setTimeout(r,35));
  if(body.stream){res.writeHead(200,{'content-type':'text/event-stream','access-control-allow-origin':'*'});res.end('data: '+JSON.stringify({model:body.model,choices:[{delta:{content:text}}],usage:{prompt_tokens:10,completion_tokens:10}})+'\n\ndata: [DONE]\n\n');return;}
  return json({content:text,model:body.model,usage:{prompt_tokens:10,completion_tokens:10}});
 }
 if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/oauth2/'))return json({});
 const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
 try{let data=fs.readFileSync(file);if(file.endsWith('.html'))data=Buffer.from(data.toString().replace('<head>','<head>\n<script src="/fixture-bootstrap.js"></script>'));res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream'});res.end(data);}catch{res.writeHead(404);res.end();}
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn){for(let i=0;i<150;i++){const r=await fn();if(r)return r;await sleep(100);}throw new Error('Browser workflow timed out.');}
let count=0;
app.whenReady().then(async()=>{
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  console.log('Dev server listening on loopback for web and mobile workflow tests.');
  for(const [surface,route,width]of [['web','/renderer/app.html',1280],['mobile','/mobile/www/index.html',430]]){
   const part=session.fromPartition('council-test-'+surface);
   part.webRequest.onBeforeRequest((details,callback)=>{
    const u=new URL(details.url);
    if(u.protocol==='https:'&&u.pathname.startsWith('/api/'))return callback({redirectURL:origin+u.pathname});
    if(u.protocol==='https:')return callback({cancel:true});
    callback({});
   });
   const win=new BrowserWindow({width,height:900,show:true,webPreferences:{partition:'council-test-'+surface,nodeIntegration:false,contextIsolation:true}});
   const js=code=>win.webContents.executeJavaScript(code);
   await win.loadURL(origin+route);await sleep(1000);
   await js('addPanel("room").then(() => true)');
   await wait(()=>js('document.querySelectorAll(".msg-contact[data-id^=model-]").length===3'));
   await js('document.querySelectorAll(".msg-contact[data-id^=model-]").forEach(b=>b.click());document.querySelector(".rc-open").click()');
   const id=await wait(()=>js('panels.find(p=>p.type==="room"&&p.roomId)?.roomId'));
   const turn=await js(`window.crowe.rooms.say(${JSON.stringify(id)},'@room Compare the options')`);assert.equal(turn.ran.filter(r=>r.ok).length,3);
   console.log('PASS '+surface+' model group messaging');count++;
   await js('document.querySelector(".room-council").click()');
   assert(await js('document.querySelector(".council-form [value=files]").disabled'));
   await js(`(()=>{const f=document.querySelector('.council-form');f.elements.goal.value='Compare the options without external actions';f.elements.maxSteps.value='1';f.elements.maxCalls.value='8';f.elements.consent.checked=true;f.requestSubmit();})()`);
   const result=await wait(async()=>{const r=await js(`window.crowe.rooms.councilState(${JSON.stringify(id)})`);return ['completed','escalated'].includes(r.council?.status)?r:null;});
   assert.equal(result.council.status,'completed',result.council.reason);assert.equal(result.council.proposals[0].votes.length,2);
   await wait(()=>js('document.querySelectorAll(".council-votes li").length===2'));
   console.log('PASS '+surface+' advisory autopilot with independent voting and receipts');count++;
   fs.writeFileSync(path.join(proof,surface+'.png'),(await win.webContents.capturePage()).toPNG());
   if(surface==='web')assert(calls.filter(p=>p.messages[0]?.content.startsWith('Independently')).every(p=>!p.files),'Council reviewer context must not inject global collections.');
   await win.webContents.reload();await sleep(700);
   const persisted=await js(`window.crowe.rooms.councilState(${JSON.stringify(id)})`);assert.equal(persisted.council.status,'completed');
   console.log('PASS '+surface+' completed council persists after reload without replay');count++;
   win.destroy();
  }
  console.log(`council-browser: ${count} checks passed; screenshots in ${path.relative(root,proof)}`);
  server.close();app.exit(0);
 }catch(e){console.error(e.stack);server.close();app.exit(1);}
});
