// Browser and phone adapters: the same Rooms engine and council protocol, with
// advisory authority only. No remote filesystem or companion bypass is offered.
(function () {
  const C = () => window.CroweCouncil;
  const stops = new Set();
  function attachCouncil(api, d) {
    const active = new Map();
    api.councilState = async id => { const room=await d.load(id); return { council:room?.council||null, history:room?.councilHistory||[], capabilities:{advisory:true,files:false} }; };
    api.councilStop = async (id,revoke=false) => {
      const room=await d.load(id); if(!room)return {error:'No such room.'};
      C().stop(room.council,revoke); active.get(id)?.abort(); await d.save(room); d.changed(room,'council');
      return {council:room.council};
    };
    api.councilStart = async (id,spec) => {
      try {
        const room=await d.load(id); if(!room)throw new Error('No such room.');
        if(active.has(id)||d.busy?.(id))throw new Error('This room is busy.');
        if(spec.mode!=='advisory')throw new Error('File execution requires the desktop. This surface grants advisory authority only.');
        const catalog=await d.catalog();
        const seats=room.agents.map(a=>{
          const entry=catalog.find(m=>m.id===a.model && m.available!==false);
          if(!entry)throw new Error('Pin an available model for every council participant.');
          return {id:a.agentId,model:a.model,engine:String(entry.engine||entry.base_model||entry.model||entry.id)};
        });
        const state=C().create(C().grant(spec,seats));
        if(room.council)(room.councilHistory||(room.councilHistory=[])).push(room.council);
        room.council=state; await d.save(room);
        const controller=new AbortController(); active.set(id,controller);
        const run=async()=>C().run(state,{
          authorized:async()=>{
            if(room.council!==state||room.agents.length!==seats.length||seats.some(s=>!room.agents.some(a=>a.agentId===s.id&&a.model===s.model)))throw new Error('Roster or model pins changed.');
          },
          save:async()=>{await d.save(room);d.changed(room,'council');},
          snapshot:async()=>({}), classify:async p=>{if(p.changes.length)throw new Error('No file authority in this surface.');},
          ask:async(seat,task,data)=>{
            const timer=setTimeout(()=>controller.abort(),Math.min(120000,Math.max(1,state.grant.expiresAt-Date.now())));
            try {
              const result=await d.chat(seat.model,[{role:'system',content:C().PROMPTS[task]},{role:'user',content:JSON.stringify(data)}],controller.signal);
              if(result.error)throw new Error(result.error);
              if(result.model&&result.model!==seat.model)throw new Error('A different model answered; vote refused.');
              if(result.tool_calls?.length)throw new Error('Council responses cannot call tools.');
              return result.content||result.text||'';
            } finally{clearTimeout(timer);}
          },
          execute:async(p,b,g,live)=>{
            if(!live())throw new Error('Authority expired or was revoked.');
            window.CroweRooms.engine.pushMessage(room,{author:window.CroweRooms.engine.SYSTEM,kind:'council',content:`Council approved: ${p.summary}`});
            return {summary:'Advisory result recorded in this Room. No external action or file write.',at:Date.now()};
          },
        });
        const promise=d.queue?d.queue(id,run):run();
        promise.catch(e=>{state.status='escalated';state.reason=String(e.message||e);d.changed(room,'council');}).finally(()=>active.delete(id));
        d.changed(room,'council'); return {council:state};
      }catch(e){return {error:String(e.message||e)};}
    };
    for(const name of ['say','critique','revise','answer','forward','delete','routineRun']){
      const original=api[name];if(!original)continue;
      api[name]=async(...args)=>{
        if(active.has(args[0])||(name==='forward'&&active.has(args[2])))return {error:'Pause council autopilot before changing this room.'};
        return original(...args);
      };
    }
    stops.add(()=>{for(const [id,c]of active){d.load(id).then(room=>{C().stop(room?.council);return d.save(room);}).catch(()=>{});c.abort();}});
    return api;
  }
  function create(d) {
    const E=window.CroweRooms.engine,G=window.CroweRooms.registry;
    const cache=new Map(), queues=new Map(),listeners=new Set();
    const records=async()=>(await d.read())||[];
    let writes=Promise.resolve();
    const save=room=>{
      const next=writes.catch(()=>{}).then(async()=>{
        const all=(await records()).filter(r=>r.id!==room.id);all.unshift(E.toSession(room));await d.write(all);
      });writes=next;return next;
    };
    const load=async id=>{
      if(cache.has(id))return cache.get(id);
      const record=(await records()).find(r=>r.id===id);const room=record?E.fromSession(record):null;
      if(room)cache.set(id,room);return room;
    };
    const changed=(room,reason)=>{for(const cb of listeners)cb({id:room.id,reason,summary:E.summary(room)});};
    const queue=(id,fn)=>{
      const next=(queues.get(id)||Promise.resolve()).catch(()=>{}).then(fn);queues.set(id,next);
      next.finally(()=>{if(queues.get(id)===next)queues.delete(id);}).catch(()=>{});return next;
    };
    function state(room){return {...E.summary(room),brief:room.brief,template:room.template,defaultAgent:room.defaultAgent,tier:'readonly',budgetUsd:room.budgetUsd,spentUsd:room.spentUsd,critiqueRounds:room.critiqueRounds,maxCritiqueRounds:E.MAX_CRITIQUE_ROUNDS,routines:room.routines,council:room.council||null,agents:room.agents.map(a=>({...a,name:G.getAgent(a.agentId)?.name||a.agentId,cost:room.cost[a.agentId]||{},ceiling:G.getAgent(a.agentId)?.autonomyCeiling||'readonly'}))};}
    async function edit(id,fn){return queue(id,async()=>{const room=await load(id);if(!room)return {error:'No such room.'};const out=await fn(room);if(out?.error)return out;await save(room);changed(room,'turn');return {...out,room:state(room)};});}
    const runner=room=>({runAgent:async req=>{
      const controller=new AbortController();
      const identity={agentId:`room:${room.id}:${req.agentId}`,roomId:room.id,roomAgent:req.agentId};
      d.emit({...identity,type:'route',model:req.model});
      const timer=setTimeout(()=>controller.abort(),120000);
      try{const out=await d.chat(req.model,[{role:'system',content:req.systemBrief},...req.messages],controller.signal);if(out.error)throw new Error(out.error);d.emit({...identity,type:'final'});return {text:out.content||out.text,usage:{usd:0,promptTokens:out.usage?.prompt_tokens||0,completionTokens:out.usage?.completion_tokens||0}};}
      catch(e){d.emit({...identity,type:'error',text:e.message});return {error:e.message};}finally{clearTimeout(timer);}
    }});
    const api={
      agents:async()=>({agents:[...G.listAgents(),...(await d.catalog()).filter(m=>m.available!==false).map(m=>G.modelAgent(m.id)).filter(Boolean)],templates:G.listTemplates()}),
      list:async()=>Promise.all((await records()).map(async r=>E.summary(await load(r.id)))),
      create:async (opts={})=>{const room=opts.template?E.fromTemplate(opts.template,opts):E.createRoom(opts);if(!room?.agents.length)return {error:'Pick at least one model or worker.'};cache.set(room.id,room);await save(room);changed(room,'create');return {room:state(room)};},
      load:async id=>{const room=await load(id);return room?{room:state(room),messages:room.messages}:{error:'No such room.'};},
      delete:async id=>queue(id,async()=>{cache.delete(id);await d.write((await records()).filter(r=>r.id!==id));for(const cb of listeners)cb({id,reason:'delete'});return {ok:true};}),
      join:(id,agentId)=>edit(id,room=>{const a=G.getAgent(agentId);if(!a||!G.isJoinable(agentId))return {error:'Unavailable participant.'};if(!room.agents.some(s=>s.agentId===agentId))room.agents.push({agentId,model:a.model||'',state:'idle'});}),
      leave:(id,agentId)=>edit(id,room=>{room.agents=room.agents.filter(a=>a.agentId!==agentId);if(room.defaultAgent===agentId)room.defaultAgent=room.agents[0]?.agentId||'';}),
      setAgentModel:(id,agentId,model)=>edit(id,room=>{const a=room.agents.find(s=>s.agentId===agentId);if(!a)return {error:'No such seat.'};a.model=String(model).slice(0,120);}),
      say:(id,text)=>edit(id,room=>E.speak(room,String(text).slice(0,60000),runner(room))),
      critique:id=>edit(id,room=>E.critique(room,runner(room))),
      revise:id=>edit(id,room=>E.revise(room,runner(room))),
      project:async(id,kind)=>{const room=await load(id);return room?E.projectRound(room,kind):{error:'No such room.'};},
      update:(id,patch)=>edit(id,room=>({changed:E.updateRoom(room,patch)})),
      markRead:(id)=>edit(id,room=>{E.markRead(room);return {unread:0};}),
      answer:(id,messageId,optionId)=>edit(id,room=>E.answerAsk(room,messageId,optionId,runner(room))),
      react:(id,messageId,kind)=>edit(id,room=>E.react(room,messageId,kind)),
      forward:async(fromId,messageId,toId,to)=>{const source=await load(fromId);return source?edit(toId,room=>E.forward(source,room,messageId,runner(room),{to})): {error:'No source room.'};},
      routineAdd:(id,spec)=>edit(id,room=>E.addRoutine(room,spec)),
      routineUpdate:(id,routineId,patch)=>edit(id,room=>E.updateRoutine(room,routineId,patch)),
      routineRemove:(id,routineId)=>edit(id,room=>E.removeRoutine(room,routineId)),
      routineRun:(id,routineId)=>edit(id,room=>E.runRoutine(room,routineId,runner(room))),
      onChanged:cb=>{listeners.add(cb);return ()=>listeners.delete(cb);},onOpen:()=>()=>{},
    };
    attachCouncil(api,{...d,load,save,changed,queue,busy:id=>queues.has(id)});
    // Foreground-only: mobile OS suspension is not an always-on worker service.
    if(typeof setInterval==='function')setInterval(async()=>{try{for(const rec of await records()){const room=await load(rec.id);if(queues.has(room.id))continue;for(const routine of E.dueRoutines(room)){if(E.claimRoutine(room,routine.id).run){await save(room);await api.routineRun(room.id,routine.id);}}}}catch{}},30000);
    return api;
  }
  window.CroweLocalRooms={attachCouncil,create,stopAll:()=>{for(const stop of stops)stop();}};
})();
