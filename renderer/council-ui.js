// One council surface in desktop, web and mobile Rooms. No authority is inferred
// from a message. The explicit form is the only way to grant an operating scope.
(function () {
  const escape = s => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.CroweCouncilUI = {
    mount(host, id, api) {
      host.className = "council-panel";
      host.innerHTML = `<header class="council-heading"><span class="council-emblem" aria-hidden="true"></span><div><span class="council-eyebrow">CROWE LOGIC / ROOMS</span><h3>Council autopilot</h3></div><span class="council-status" role="status">Not authorized</span></header>
        <p class="council-intro">A shared objective. Independent votes. Authority stays with you.</p>
        <div class="council-progress" aria-label="Approval workflow"><span>Propose</span><span>Classify</span><span>Vote</span><span>Execute</span><span>Verify</span></div>
        <form class="council-form">
          <label>Standing objective<textarea name="goal" rows="3" required maxlength="4000" placeholder="Describe the outcome and the constraints the council must respect."></textarea></label>
          <label>Authority<select name="mode"><option value="advisory">Advisory: deliberate and record results</option><option value="files">Files: only the exact paths below</option></select></label>
          <label class="council-files" hidden>Allowed files, one workspace-relative path per line<textarea name="files" rows="3" placeholder="src/example.js"></textarea></label>
          <div class="council-grid"><label>Approval quorum<input name="quorum" type="number" min="2" max="7" value="2" required></label><label>Maximum steps<input name="maxSteps" type="number" min="1" max="10" value="3" required></label><label>Model-call limit<input name="maxCalls" type="number" min="5" max="100" value="20" required></label><label>Expires in minutes<input name="minutes" type="number" min="1" max="60" value="10" required></label></div>
          <p class="council-boundary">At least three distinct pinned engines. The proposer cannot vote. A rejection or classifier warning stops the cycle. No shell, publishing, payments, or new permissions. Call limits are not a dollar spending guarantee.</p>
          <label class="council-consent"><input type="checkbox" name="consent" required>I authorize this scope until expiry. Approved file changes apply without another prompt.</label>
          <button class="primary council-start" type="submit">Authorize and start</button>
        </form>
        <div class="council-controls"><button type="button" class="ghost council-pause">Pause</button><button type="button" class="ghost council-revoke">Revoke authority</button></div>
        <p class="council-note" role="status"></p><div class="council-ledger" aria-label="Council proposals and voting receipts"></div><details class="council-history"><summary>Previous operating agreements</summary><div></div></details>`;
      const mark = host.querySelector('.council-emblem');
      if (window.CroweMarks) window.CroweMarks.mount(mark, {id:'council',mark:'coalesce'}, {state:'rest'});
      const form = host.querySelector('form'), note = host.querySelector('.council-note');
      let current = null, disposed = false, last = '';
      const roomId = () => typeof id === 'function' ? id() : id;
      form.elements.mode.addEventListener('change', () => { host.querySelector('.council-files').hidden = form.elements.mode.value !== 'files'; });
      async function refresh() {
        if (disposed || !roomId() || !api.councilState) return;
        const out = await api.councilState(roomId());
        if (disposed) return;
        if (out.error) { note.textContent = out.error; return; }
        if (!out.capabilities?.files) { form.elements.mode.querySelector('[value="files"]').disabled = true; }
        current = out.council;
        const status = current?.status || 'Not authorized';
        const active = ['ready','proposing','classifying','voting','executing','verifying'].includes(status);
        host.dataset.state = status;
        host.querySelector('.council-status').textContent = status;
        host.querySelector('.council-pause').disabled = !active;
        host.querySelector('.council-revoke').disabled = !current || status === 'revoked';
        form.querySelectorAll('input,textarea,select,button').forEach(el => { el.disabled = active; });
        if (!out.capabilities?.files) form.elements.mode.querySelector('[value="files"]').disabled = true;
        if (window.CroweMarks) window.CroweMarks.setMarkState(mark, active ? 'reasoning' : status === 'escalated' ? 'failed' : 'rest');
        const stages = ['proposing','classifying','voting','executing','verifying'];
        host.querySelectorAll('.council-progress span').forEach((el,i) => { el.classList.toggle('active', stages[i] === status); if (stages[i] === status) el.setAttribute('aria-current','step'); else el.removeAttribute('aria-current'); });
        note.textContent = current ? `${current.steps}/${current.grant.maxSteps} steps | ${current.calls}/${current.grant.maxCalls} calls | ${current.reason || 'Operating within your agreement.'}` : 'Choose model contacts for a council, then authorize its objective here.';
        host.querySelector('.council-history div').innerHTML = (out.history || []).slice().reverse().map(h => `<article class="council-card"><strong>${escape(h.status)}</strong><p>${escape(h.grant.goal)}</p><p>${escape(h.reason)}</p><details><summary>Voting and recovery record</summary><pre class="council-history-record">${escape(JSON.stringify(h,null,2))}</pre></details></article>`).join('') || '<p>No previous agreements.</p>';
        const serialized = JSON.stringify(current?.proposals || []);
        if (serialized === last) return;
        last = serialized;
        host.querySelector('.council-ledger').innerHTML = (current?.proposals || []).slice().reverse().map(p => `<article class="council-card"><div class="council-card-head"><strong>${escape(p.status)}</strong><code title="Exact proposal and scope hash">${escape(p.hash.slice(0,12))}</code></div><p>${escape(p.proposal.summary)}</p>${p.safety ? `<p class="council-safety">Safety: ${escape(p.safety.decision)}. ${escape(p.safety.reason)}</p>`:''}<ul class="council-votes">${p.votes.map(v=>`<li data-vote="${escape(v.decision)}"><strong>${escape(v.decision)}</strong><span>${escape(v.model)}</span><p>${escape(v.reason)}</p></li>`).join('')}</ul>${p.proposal.changes.map(c=>`<details><summary>Review ${escape(c.path)}</summary><div class="council-diff"><strong>Before / recovery snapshot</strong><pre>${escape(p.before[c.path])}</pre><strong>Approved replacement</strong><pre>${escape(c.content)}</pre></div></details>`).join('')}${p.receipt?`<p class="council-receipt">${escape(p.receipt.summary)}</p>`:''}${p.verification?`<p>Verification: ${escape(p.verification.decision)}. ${escape(p.verification.reason)}</p>`:''}</article>`).join('');
      }
      form.addEventListener('submit', async e => {
        e.preventDefault(); if (!roomId() || !form.reportValidity()) return;
        const fields = new FormData(form);
        const spec = {goal:fields.get('goal'), mode:fields.get('mode'), files:String(fields.get('files')||'').split('\n').map(s=>s.trim()).filter(Boolean)};
        for (const key of ['quorum','maxSteps','maxCalls','minutes']) spec[key] = Number(fields.get(key));
        note.textContent = 'Checking the operating agreement...';
        try { const result = await api.councilStart(roomId(),spec); if (result.error) { note.textContent=result.error; return; } form.elements.consent.checked=false; await refresh(); }
        catch(e) { note.textContent=String(e.message||e); }
      });
      for (const [selector,revoke] of [['.council-pause',false],['.council-revoke',true]]) host.querySelector(selector).addEventListener('click',async()=>{try{const out=await api.councilStop(roomId(),revoke);if(out.error)note.textContent=out.error;else await refresh();}catch(e){note.textContent=e.message;}});
      refresh().catch(e=>{note.textContent=e.message;});
      return { refresh, dispose:()=>{disposed=true;} };
    },
  };
})();
