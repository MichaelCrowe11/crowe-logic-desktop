#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../rooms/council');
const R = require('../rooms/engine');
const G = require('../rooms/registry');
const {makeFileExecutor} = require('../rooms/council-files');
fs.mkdirSync(path.join(__dirname, '../.council-test'), { recursive: true });
const seats = ['a','b','c'].map(id => ({id, model:id, engine:id}));
const spec = {goal:'Correct the fixture', mode:'files', files:['example.txt'], quorum:2, maxSteps:1, maxCalls:8, minutes:10};
let count=0;
async function test(name,fn){await fn();console.log('PASS '+name);count++;}
function fixture(options={}){
  const state=C.create(C.grant({...spec,...options.spec},options.seats||seats));
  let files={'example.txt':'before'}, executions=0, requests=[];
  const deps={
    save:async()=>{},authorized:async()=>{},snapshot:async()=>({...files}),classify:async()=>{},
    ask:async(seat,task,data)=>{
      requests.push({seat,task,data});
      if(options.onAsk)await options.onAsk({seat,task,data,state,files});
      if(task==='propose')return JSON.stringify(options.proposal||{kind:'propose',summary:'Correct the fixture',changes:[{path:'example.txt',content:'after'}]});
      if(task==='classify')return JSON.stringify({decision:options.safety||'allow',reason:'Within the explicit file scope.'});
      return JSON.stringify({decision:options.vote||'approve',reason:'Compared against the exact proposal and file evidence.'});
    },
    execute:async(p,b,g,live)=>{assert(live());executions++;for(const c of p.changes)files[c.path]=c.content;return {summary:'Read back approved contents.'};},
  };
  return {state,deps,get executions(){return executions;},get requests(){return requests;},get files(){return files;}};
}
(async()=>{
 await test('full proposal, classifier, independent votes, execution and verification',async()=>{const f=fixture();await C.run(f.state,f.deps);assert.equal(f.state.status,'completed');assert.equal(f.executions,1);assert.equal(f.state.proposals[0].status,'verified');assert.equal(f.state.calls,5);assert.equal(f.files['example.txt'],'after');});
 await test('no proposer vote and no peer votes in reviewer context',async()=>{const f=fixture();await C.run(f.state,f.deps);for(const r of f.requests.filter(r=>r.task==='vote')){assert.notEqual(r.seat.id,'a');assert(!('votes' in r.data));}assert.equal(f.state.proposals[0].votes.length,2);});
 await test('reject veto cannot be outvoted',async()=>{const f=fixture({vote:'reject'});await C.run(f.state,f.deps);assert.equal(f.executions,0);assert.equal(f.state.status,'escalated');});
 await test('abstention is not approval',async()=>{const f=fixture({vote:'abstain'});await C.run(f.state,f.deps);assert.equal(f.executions,0);});
 await test('safety classifier block overrides council',async()=>{const f=fixture({safety:'block'});await C.run(f.state,f.deps);assert.equal(f.executions,0);assert.equal(f.state.calls,2);});
 await test('missing classifier decision fails closed',async()=>{const f=fixture();const ask=f.deps.ask;f.deps.ask=async(s,t,d)=>t==='classify'?'{}':ask(s,t,d);await C.run(f.state,f.deps);assert.equal(f.executions,0);});
 await test('stale file invalidates every vote',async()=>{const f=fixture({onAsk:({task,files})=>{if(task==='vote')files['example.txt']='external edit';}});await C.run(f.state,f.deps);assert.equal(f.executions,0);assert.match(f.state.reason,/stale/);});
 await test('revocation during a vote prevents execution',async()=>{const f=fixture({onAsk:({task,state})=>{if(task==='vote')C.stop(state,true);}});await C.run(f.state,f.deps);assert.equal(f.executions,0);assert.equal(f.state.status,'revoked');});
 await test('changed contract invalidates vote',async()=>{const f=fixture({onAsk:({task,state})=>{if(task==='vote')state.grant.goal='different';}});await C.run(f.state,f.deps);assert.equal(f.executions,0);assert.match(f.state.reason,/agreement changed/);});
 await test('expired authority cannot run',async()=>{const f=fixture();f.deps.now=()=>f.state.grant.expiresAt+1;await C.run(f.state,f.deps);assert.equal(f.state.calls,0);});
 await test('reserve a complete cycle before model spend',async()=>{const f=fixture({seats:[...seats,{id:'d',model:'d',engine:'d'}],spec:{maxCalls:5}});await C.run(f.state,f.deps);assert.equal(f.state.calls,0);});
 await test('scope cannot be widened by proposal',async()=>{const f=fixture({proposal:{kind:'propose',summary:'Outside scope',changes:[{path:'other.txt',content:'bad'}]}});await C.run(f.state,f.deps);assert.equal(f.executions,0);});
 await test('advisory authority rejects file writes',async()=>{const f=fixture({spec:{mode:'advisory'}});await C.run(f.state,f.deps);assert.equal(f.executions,0);});
 await test('advisory completion also requires votes and verification',async()=>{const f=fixture({spec:{mode:'advisory'},proposal:{kind:'complete',summary:'Evidence-backed recommendation.',changes:[]}});await C.run(f.state,f.deps);assert.equal(f.state.status,'completed');assert.equal(f.state.calls,5);});
 await test('duplicate engines cannot manufacture a quorum',()=>assert.throws(()=>C.grant(spec,[seats[0],seats[1],{...seats[2],engine:'b'}]),/distinct/));
 await test('invalid numeric limits rejected rather than coerced',()=>assert.throws(()=>C.grant({...spec,maxCalls:NaN},seats),/Calls/));
 await test('interrupted execution never automatically replays',()=>{const f=fixture();f.state.status='executing';C.recover(f.state);assert.equal(f.state.status,'paused');assert.rejects(C.run(f.state,f.deps),/newly authorized/);});
 await test('storage failure stops before mutation',async()=>{const f=fixture();f.deps.save=async()=>{throw new Error('disk full');};await assert.rejects(C.run(f.state,f.deps),/disk full/);assert.equal(f.executions,0);});
 await test('model contacts survive persistence and addressing',()=>{const contact=G.modelAgent('vendor/model-v1');assert.equal(G.getAgent(contact.id).model,'vendor/model-v1');const room=R.createRoom({agentIds:[contact.id,contact.id]});assert.equal(room.agents.length,1);assert.equal(R.parseAddress('@'+contact.id+' hello',room).to[0],contact.id);assert.equal(R.fromSession(R.toSession(room)).agents[0].model,contact.model);});
 await test('real scoped executor writes only approved UTF-8 file and verifies',()=>{const dir=fs.mkdtempSync(path.join(__dirname,'../.council-test/files-'));fs.writeFileSync(path.join(dir,'example.txt'),'before');const f=makeFileExecutor(dir,['example.txt']);const before=f.snapshot();const out=f.execute({changes:[{path:'example.txt',content:'after'}]},before,{},()=>true);assert.equal(fs.readFileSync(path.join(dir,'example.txt'),'utf8'),'after');assert.equal(out.files.length,1);});
 await test('file executor rejects symlink and policy file',()=>{const dir=fs.mkdtempSync(path.join(__dirname,'../.council-test/links-'));fs.writeFileSync(path.join(dir,'target.txt'),'safe');fs.symlinkSync('target.txt',path.join(dir,'link.txt'));assert.throws(()=>makeFileExecutor(dir,['link.txt']).snapshot(),/links/);fs.writeFileSync(path.join(dir,'package.json'),'{}');assert.throws(()=>makeFileExecutor(dir,['package.json']).snapshot(),/manual review/);});
 await test('file executor refuses stale data and revocation',()=>{const dir=fs.mkdtempSync(path.join(__dirname,'../.council-test/stale-'));fs.writeFileSync(path.join(dir,'example.txt'),'before');const f=makeFileExecutor(dir,['example.txt']);const before=f.snapshot();fs.writeFileSync(path.join(dir,'example.txt'),'changed');assert.throws(()=>f.execute({changes:[]},before,{},()=>true),/changed/);assert.throws(()=>f.execute({changes:[]},before,{},()=>false),/revoked/);});
 // The desktop host behind IPC, with an injected boundary: no Electron, no
 // network, stubbed inference. Authority questions are answered by the host.
 const host=()=>{const {installCouncilHost}=require('../rooms/council-host');const handlers={};let pending=null;const catalog=['a','b','c'].map(id=>({id,engine:'engine-'+id,available:true}));
   const make=(agentIds,cfg,reply)=>{const room=R.createRoom({agentIds});room.agents.forEach((a,i)=>{a.model=['a','b','c'][i];});
     const d={ipcMain:{handle:(name,fn)=>{handlers[name]=fn;}},loadRoom:()=>room,save:()=>{},changed:()=>{},busy:()=>false,queue:(id,fn)=>{pending=fn();return pending;},config:cfg,catalog:()=>catalog,chat:async(messages,tools,retried,signal,model)=>({content:JSON.stringify(reply(messages)),model})};
     installCouncilHost(d);return {room,start:(spec)=>handlers['crowe:rooms:council-start'](null,{id:room.id,spec}),settled:()=>pending};};
   return make;};
 const models=['a','b','c'].map(m=>G.modelAgent(m).id);
 await test('desktop host refuses file autopilot for a read-only roster even under Execute autonomy',async()=>{
   const h=host()(['revenue',models[1],models[2]],()=>({autonomy:'execute',cwd:process.cwd(),token:'t',model:'a'}),()=>({}));
   assert.equal(G.getAgent('revenue').autonomyCeiling,'readonly');
   const out=await h.start({goal:'Correct the fixture',mode:'files',files:['example.txt'],quorum:2,maxSteps:1,maxCalls:8,minutes:5});
   assert.match(out.error,/effective tier is readonly/);assert(!h.room.council);
 });
 await test('desktop host fails closed when configured autonomy is missing or invalid',async()=>{
   for(const autonomy of [undefined,'exeucte','']){
     const h=host()(models,()=>({autonomy,cwd:process.cwd(),token:'t',model:'a'}),()=>({}));
     const out=await h.start({goal:'Correct the fixture',mode:'files',files:['example.txt'],quorum:2,maxSteps:1,maxCalls:8,minutes:5});
     assert.match(out.error,/effective tier is plan/);assert(!h.room.council);
   }
 });
 await test('desktop host accepts an edit-capable roster and records advisory receipts with the approved text',async()=>{
   const reply=(messages)=>{const sys=messages[0].content;if(sys.startsWith('Propose'))return {kind:'complete',summary:'Recommendation for the record.',changes:[]};if(sys.startsWith('Act as a safety'))return {decision:'allow',reason:'Advisory, no changes.'};return {decision:'approve',reason:'Matches the recorded evidence.'};};
   const h=host()(models,()=>({autonomy:'edit',cwd:process.cwd(),token:'t',model:'a'}),reply);
   const out=await h.start({goal:'Record a recommendation',mode:'advisory',files:[],quorum:2,maxSteps:1,maxCalls:8,minutes:5});
   assert(!out.error,out.error);await h.settled();
   assert.equal(h.room.council.status,'completed');
   assert.equal(h.room.council.proposals[0].receipt.recorded,'Recommendation for the record.');
   assert.equal(h.room.council.proposals[0].receipt.kind,'complete');
   assert(h.room.messages.some(m=>m.kind==='council'));
 });
 await test('desktop host stops a file grant when autonomy drops below edit mid-vote',async()=>{
   const dir=fs.mkdtempSync(path.join(__dirname,'../.council-test/host-'));fs.writeFileSync(path.join(dir,'example.txt'),'before');let autonomy='edit';
   const reply=(messages)=>{const sys=messages[0].content;if(sys.startsWith('Propose'))return {kind:'propose',summary:'Correct the fixture',changes:[{path:'example.txt',content:'after'}]};if(sys.startsWith('Act as a safety'))return {decision:'allow',reason:'In scope.'};if(sys.startsWith('Independently review'))autonomy='plan';return {decision:'approve',reason:'Compared.'};};
   const h=host()(models,()=>({autonomy,cwd:dir,token:'t',model:'a'}),reply);
   const out=await h.start({goal:'Correct the fixture',mode:'files',files:['example.txt'],quorum:2,maxSteps:1,maxCalls:8,minutes:5});
   assert(!out.error,out.error);await h.settled();
   assert.equal(h.room.council.status,'escalated');assert.match(h.room.council.reason,/autonomy/);
   assert.equal(fs.readFileSync(path.join(dir,'example.txt'),'utf8'),'before');
 });
 console.log(`council: ${count} checks passed`);
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
