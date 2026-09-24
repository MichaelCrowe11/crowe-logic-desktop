/* Reusable staff Messenger. No transport, auth, inference, or browser storage.
 * Load farm-messenger.css, then FarmMessenger.mount(container, { request },
 * { onFarmChanged(selection) }). Returns open, deactivate, currentSelection,
 * and destroy. Deactivate on hidden tabs; open resumes without losing drafts.
 * The host MUST destroy/remount on account change, sign-out, or workspace close.
 * Locked team API: create participantIds, send text, list afterSequence/limit,
 * read sequence+requestId. Conversation DTOs contain memberIds. No readBy is
 * currently supplied by the human service; never synthesize those receipts.
 * Each send is an immutable idempotent intent. The service must atomically
 * deduplicate requestId in the authenticated farm/conversation/sender scope.
 * Optional: farm.capabilities.quickLinks [{kind,recordId,title,subtitle}] and
 * api.openRecord({farmId,kind,recordId}); supported kinds: sop, training, timekeeping.
 * Lists accept arrays or {items}. Never derive human read receipts from replies.
 */
(function (root, factory) {
  'use strict';
  const moduleApi = factory();
  if (typeof module === 'object' && module.exports) module.exports = moduleApi;
  root.FarmMessenger = moduleApi;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const BODY_LIMIT = 5000, TITLE_LIMIT = 120, POLL_MS = 12000, REQUEST_MS = 20000;
  const RECORD_KINDS = new Set(['sop', 'training', 'timekeeping']);
  let mounts = 0;
  const text = (value, limit = 1000) => typeof value === 'string' ? value.slice(0, limit) : '';
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : '';
  function items(data) {
    const list = Array.isArray(data) ? data : data && data.items;
    if (!Array.isArray(list)) throw new Error('The service returned an invalid list.');
    return list.filter(row => row && typeof row === 'object' && id(row.id));
  }
  function timestamp(value) {
    if (value === undefined || value === null || value === '') return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function requestId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    if (!globalThis.crypto || !globalThis.crypto.getRandomValues) throw new Error('Secure request IDs are unavailable. Nothing was sent.');
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2, '0')).join('');
  }
  function mount(container, api, options = {}) {
    if (!container || typeof container.append !== 'function') throw new TypeError('A Messenger container is required.');
    const doc = container.ownerDocument, win = doc.defaultView, prefix = `fm-${++mounts}`;
    let alive = true, active = true, farmEpoch = 0, threadEpoch = 0, farmListEpoch = 0;
    let farms = [], farm = null, conversations = [], members = [], selected = null;
    let available = false, messageReady = false, memberReady = false, timer = null, dialog = null;
    let farmLoading = false, threadLoading = false, latestSequence = 0, readBusy = false, messageRows = [], departments = [];
    const readIntents = new Map();
    const drafts = new Map(), attempts = new Map(), createDrafts = new Map(), readSequences = new Map();
    const cancellations = new Set(), listeners = [];
    const keyFor = (farmId, conversationId) => JSON.stringify([farmId, conversationId]);
    const currentKey = () => farm && selected ? keyFor(farm.id, selected.id) : '';
    const selection = () => alive && farm ? { farmId: farm.id, currentMemberId: id(farm.currentMemberId), role: text(farm.role, 80) } : null;
    function notifyFarm() { if (typeof options.onFarmChanged === 'function') { try { options.onFarmChanged(selection()); } catch (_) { /* Host callback cannot break account isolation. */ } } }
    const current = (fe, te) => alive && fe === farmEpoch && (te === undefined || te === threadEpoch);
    function el(tag, attrs = {}, ...children) {
      const node = doc.createElement(tag);
      for (const [name, value] of Object.entries(attrs)) {
        if (name === 'className') node.className = value;
        else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
        else if (value !== undefined && value !== null && value !== false) node.setAttribute(name, value === true ? '' : String(value));
      }
      for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child.nodeType ? child : doc.createTextNode(String(child)));
      return node;
    }
    const button = (label, fn, attrs = {}) => el('button', { type: 'button', onclick: fn, ...attrs }, label);
    const caption = label => el('p', { className: 'fm-caption' }, label);
    function listen(target, event, fn) { target.addEventListener(event, fn); listeners.push(() => target.removeEventListener(event, fn)); }
    const root = el('section', { className: 'farm-messenger', 'aria-label': 'Team Messenger' });
    const farmSelect = el('select', { id: `${prefix}-farm`, 'data-fm': 'farm', onchange: () => chooseFarm(farmSelect.value) });
    const status = el('p', { className: 'fm-connection', role: 'status', 'aria-live': 'polite', 'data-fm': 'status' }, 'Connecting to Messenger...');
    const error = el('p', { className: 'fm-error', role: 'alert', hidden: true, 'data-fm': 'error' });
    const retryConnection = button('Refresh', () => refresh(), { 'data-fm': 'refresh' });
    const newButton = button('New message', () => openCreate(), { className: 'fm-new', disabled: true, 'data-fm': 'new' });
    const farmCreate = el('form', { className: 'fm-farm-create', hidden: true, 'data-fm': 'farm-create' });
    const farmName = el('input', { id: `${prefix}-farm-name`, maxlength: 120, required: true, name: 'name' });
    const createFarmButton = el('button', { type: 'submit' }, 'Create farm workspace');
    const farmCreateNote = caption('Create a new, empty workspace. You become its owner. No staff or records are added automatically.');
    farmCreate.append(el('label', { for: farmName.id }, 'New farm name'), farmName, createFarmButton, farmCreateNote);
    const farmCreateIntents = new Map();
    let farmCreateBusy = false;
    farmCreate.addEventListener('submit', async event => {
      event.preventDefault(); const name = farmName.value.trim();
      if (!alive || !active || farmCreate.hidden || farmCreateBusy || !name || name.length > 120) return;
      farmCreateBusy = true; createFarmButton.disabled = true; farmCreateNote.textContent = 'Creating farm workspace...';
      try {
        if (!farmCreateIntents.has(name)) farmCreateIntents.set(name, requestId());
        const result = await request('farm.create', { requestId: farmCreateIntents.get(name), name });
        if (!alive) return;
        const created = result?.farm || result;
        if (!id(created?.id)) throw new Error('Creation returned no farm ID. Retry with the same name to reuse its request ID.');
        await loadFarms();
        if (alive && farms.some(row => row.id === created.id) && farm?.id !== created.id) await chooseFarm(created.id);
      } catch (err) { if (alive) farmCreateNote.textContent = 'Creation not confirmed. Retry the same name. ' + err.message; }
      finally { if (alive) { farmCreateBusy = false; createFarmButton.disabled = false; } }
    });
    const sidebar = el('aside', { className: 'fm-sidebar', 'aria-label': 'Conversations' });
    const search = el('input', { type: 'search', id: `${prefix}-search`, placeholder: 'Find a conversation', maxlength: 120, 'data-fm': 'search', oninput: () => renderConversations() });
    const filters = el('div', { className: 'fm-filters', role: 'group', 'aria-label': 'Filter conversations' });
    let filter = 'all';
    for (const [value, label] of [['all', 'All'], ['unread', 'Unread'], ['department', 'Departments']]) {
      filters.append(button(label, () => { filter = value; renderConversations(); }, { 'data-filter': value, 'aria-pressed': value === 'all' }));
    }
    const list = el('div', { className: 'fm-conversations', 'data-fm': 'conversations' });
    const quickLinks = el('nav', { className: 'fm-quicklinks', 'aria-label': 'Staff resources' });
    sidebar.append(el('header', { className: 'fm-sidebar-head' }, el('p', { className: 'fm-eyebrow' }, 'MYCOLOGY / TEAM'), el('h1', {}, 'Messenger'),
      el('label', { for: farmSelect.id }, 'Farm workspace'), farmSelect, newButton, farmCreate),
      el('div', { className: 'fm-search' }, el('label', { for: search.id, className: 'fm-sr' }, 'Search conversations'), search, filters), list, quickLinks);
    const detail = el('section', { className: 'fm-detail', 'aria-label': 'Conversation' });
    const title = el('h2', { tabindex: '-1', 'data-fm': 'title' }, 'Your team, in one place');
    const subtitle = caption('Direct messages, groups and department alerts.');
    const back = button('Conversations', () => { root.classList.remove('fm-thread-open'); list.querySelector('[aria-current="true"]')?.focus(); }, { className: 'fm-back', 'data-fm': 'back' });
    const header = el('header', { className: 'fm-thread-head' }, back, el('div', {}, title, subtitle));
    const thread = el('div', { className: 'fm-thread', tabindex: '0', role: 'region', 'aria-label': 'Message history', 'data-fm': 'thread' });
    const history = el('ol', { className: 'fm-history', 'aria-label': 'Messages' });
    const empty = el('div', { className: 'fm-empty' }, el('h3', {}, 'Select a conversation'), caption('Only conversations returned by your farm service appear here. No sample staff or messages.'));
    const outbox = el('ol', { className: 'fm-outbox', 'aria-label': 'Your send attempts', 'data-fm': 'outbox' });
    const more = button('Load newer messages', () => loadMessages(), { hidden: true, 'data-fm': 'more' });
    thread.append(empty, history, more, outbox);
    const jump = button('Latest messages', () => { thread.scrollTop = thread.scrollHeight; jump.hidden = true; markRead(); }, { className: 'fm-jump', hidden: true });
    const compose = el('form', { className: 'fm-compose', 'data-fm': 'compose' });
    const input = el('textarea', { id: `${prefix}-body`, rows: '2', maxlength: BODY_LIMIT, placeholder: 'Write a message', disabled: true, 'data-fm': 'body' });
    const send = el('button', { type: 'submit', className: 'fm-send', disabled: true, 'data-fm': 'send' }, 'Send');
    const composeNote = el('p', { className: 'fm-caption', id: `${prefix}-draft-note`, 'data-fm': 'draft-note' }, 'Drafts stay in this open workspace only. Closing or signing out clears them.');
    input.setAttribute('aria-describedby', composeNote.id);
    const counter = el('span', { className: 'fm-counter', 'data-fm': 'counter' }, `0 / ${BODY_LIMIT}`);
    compose.append(el('label', { for: input.id }, 'Message'), input,
      el('div', { className: 'fm-compose-actions' }, caption('Enter to send. Shift + Enter for a new line.'), counter, send), composeNote);
    const announce = el('p', { className: 'fm-sr', role: 'status', 'aria-live': 'polite', 'data-fm': 'announce' });
    detail.append(header, thread, jump, compose, announce);
    const connection = el('div', { className: 'fm-connection-area' }, el('div', { className: 'fm-statusbar' }, status, retryConnection), error);
    root.append(connection, sidebar, detail); container.append(root);

    function showError(err) { error.textContent = text(err?.message, 400) || 'Messenger is unavailable. Your draft is retained in this open workspace.'; error.hidden = false; }
    function clearError() { error.hidden = true; error.textContent = ''; }
    async function request(action, payload = {}) {
      if (!alive) throw new Error('This Messenger has closed.');
      if (!api || typeof api.request !== 'function') throw new Error('Messenger is unavailable. This host has no authenticated messaging connection.');
      // The bridge contract has no AbortSignal. Cancel waits/timers and ignore
      // late results; never claim that cancelling a wait cancelled a server send.
      const result = await new Promise((resolve, reject) => {
        let done = false;
        const finish = (fn, value) => { if (done) return; done = true; win.clearTimeout(timeout); cancellations.delete(cancel); fn(value); };
        const cancel = () => finish(reject, new Error('This Messenger has closed.'));
        const timeout = win.setTimeout(() => finish(reject, new Error('Connection timed out. The result is not confirmed. Retry the same attempt, not a new message.')), REQUEST_MS);
        cancellations.add(cancel);
        Promise.resolve().then(() => { if (!alive) throw new Error('This Messenger has closed.'); return api.request(action, payload); })
          .then(value => finish(resolve, value), () => finish(reject, new Error('Connection interrupted. The result is not confirmed. Your draft is retained.')));
      });
      if (!result || result.ok !== true) throw new Error(text(result?.error?.message, 400) || 'Messenger service unavailable. No result was confirmed.');
      return result.data;
    }
    function identity(member) {
      if (!member) return 'Identity not supplied';
      return member.kind === 'crowe-logic' ? 'Crowe Logic' : text(member.name, 120) || text(member.displayName, 120) || 'Unnamed member';
    }
    function selfId() { return id(farm?.currentMemberId) || id(members.find(member => member.isSelf === true)?.id); }
    function conversationTitle(conversation) {
      return text(conversation.title, TITLE_LIMIT) || (conversation.memberIds || []).filter(memberId => memberId !== selfId()).map(memberId => identity(members.find(member => member.id === memberId))).join(', ') || 'Untitled conversation';
    }
    function unread(conversation) { const n = conversation.unreadCount; return Number.isSafeInteger(n) && n > 0 ? n : 0; }
    function renderConversations() {
      const focusedId = list.contains(doc.activeElement) ? doc.activeElement?.dataset.conversation : null;
      for (const b of filters.children) b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
      const q = search.value.trim().toLocaleLowerCase();
      const rows = conversations.filter(c => (filter !== 'unread' || unread(c)) && (filter !== 'department' || c.kind === 'department') && conversationTitle(c).toLocaleLowerCase().includes(q));
      list.replaceChildren();
      if (!rows.length) list.append(caption(farmLoading ? 'Loading conversations...' : !available ? 'Connect to load conversations.' : conversations.length ? 'No matching conversations.' : 'No conversations yet. Start with a real member of your farm.'));
      for (const conversation of rows) {
        const count = unread(conversation), label = conversationTitle(conversation);
        const row = button('', () => chooseConversation(conversation.id, true), { className: 'fm-conversation', 'data-conversation': conversation.id, 'aria-current': selected?.id === conversation.id ? 'true' : 'false' });
        row.append(el('span', { className: 'fm-avatar', 'aria-hidden': 'true' }, label.slice(0, 2).toLocaleUpperCase()),
          el('span', { className: 'fm-row-copy' }, el('strong', {}, label), el('span', { className: 'fm-caption' }, conversation.kind === 'department' ? 'Department alerts' : conversation.kind === 'group' ? 'Group conversation' : 'Direct message'),
            el('span', { className: 'fm-preview' }, text(conversation.lastMessage?.text, 100) || text(conversation.preview, 100) || 'Open conversation')),
          el('span', { className: 'fm-row-meta' }, el('span', { className: 'fm-caption' }, timestamp(conversation.updatedAt)), count ? el('span', { className: 'fm-unread', 'aria-label': `${count} unread messages` }, count > 99 ? '99+' : count) : null));
        list.append(row);
      }
      if (focusedId) [...list.children].find(row => row.dataset.conversation === focusedId)?.focus({ preventScroll: true });
    }
    function renderLinks() {
      quickLinks.replaceChildren(el('h3', {}, 'Staff resources'));
      const cards = Array.isArray(farm?.capabilities?.quickLinks) ? farm.capabilities.quickLinks : [];
      for (const kind of RECORD_KINDS) {
        const card = cards.find(item => item && item.kind === kind && id(item.recordId));
        const label = kind === 'sop' ? 'SOP reference' : kind === 'training' ? 'Training' : 'Timekeeping';
        if (card && typeof api?.openRecord === 'function') quickLinks.append(recordButton(card, label));
        else quickLinks.append(el('div', { className: 'fm-resource-unavailable' }, el('span', {}, label), el('span', { className: 'fm-caption' }, 'Not connected')));
      }
    }
    function recordButton(card, fallback) {
      const fid = farm.id;
      return button(text(card.title, 120) || fallback, async () => {
        if (!alive || farm?.id !== fid) return;
        try { await api.openRecord({ farmId: fid, kind: card.kind, recordId: card.recordId }); }
        catch (_) { if (alive && farm?.id === fid) showError(new Error('This staff resource could not be opened.')); }
      }, { className: 'fm-record', title: text(card.subtitle, 200) || undefined });
    }
    function updateComposer() {
      input.disabled = !selected;
      send.disabled = !selected || !messageReady || !available || !input.value.trim() || input.value.length > BODY_LIMIT;
      counter.textContent = `${input.value.length} / ${BODY_LIMIT}`;
      newButton.disabled = !available || !memberReady || !farm || !!createDrafts.get(farm?.id)?.busy;
    }
    function saveDraft() { const key = currentKey(); if (key) drafts.set(key, input.value); updateComposer(); }
    input.addEventListener('input', saveDraft);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!send.disabled) compose.requestSubmit(); }
    });
    compose.addEventListener('submit', event => { event.preventDefault(); if (alive && !send.disabled) sendDraft(); });
    function clearThread() {
      messageReady = false; latestSequence = 0; messageRows = []; historySignature = ''; readBusy = false; history.replaceChildren(); outbox.replaceChildren(); jump.hidden = true; more.hidden = true;
      empty.hidden = false; empty.replaceChildren(el('h3', {}, selected ? 'Loading messages...' : 'Select a conversation'), caption(selected ? 'Reading from your farm service.' : 'Your team conversations appear here.'));
      input.value = drafts.get(currentKey()) || ''; updateComposer();
    }
    function updateHeader() {
      title.textContent = selected ? conversationTitle(selected) : 'Your team, in one place';
      const people = selected ? (selected.memberIds || []).map(memberId => members.find(member => member.id === memberId)).filter(Boolean) : [];
      subtitle.textContent = selected ? (selected.kind === 'department' ? 'Department alerts. ' : '') + (people.length ? people.map(identity).join(' · ') : 'Participant identities are supplied by the farm service.') : 'Direct messages, groups and department alerts.';
      if (people.some(member => member.kind === 'crowe-logic')) subtitle.textContent += ' Crowe Logic is a software participant.';
    }
    async function loadFarms() {
      const epoch = ++farmListEpoch; retryConnection.disabled = true; status.textContent = 'Connecting to Messenger...';
      try {
        const rows = items(await request('farm.list'));
        if (!alive || epoch !== farmListEpoch) return;
        farms = rows; farmCreate.hidden = rows.length > 0; farmSelect.replaceChildren(el('option', { value: '' }, rows.length ? 'Select your farm' : 'No farms available'));
        for (const row of rows) farmSelect.append(el('option', { value: row.id }, text(row.name, 120) || 'Unnamed farm'));
        farmSelect.value = farm?.id || '';
        if (farm && !rows.some(row => row.id === farm.id)) chooseFarm('');
        if (!farm && rows.length === 1) await chooseFarm(rows[0].id);
        else { status.textContent = rows.length ? 'Select a farm workspace.' : 'No farm membership returned. Ask your farm administrator for access.'; clearError(); }
      } catch (err) { if (alive && epoch === farmListEpoch) { available = false; status.textContent = 'Messenger unavailable'; showError(err); updateComposer(); renderConversations(); } }
      finally { if (alive && epoch === farmListEpoch) retryConnection.disabled = false; }
    }
    async function chooseFarm(farmId) {
      if (!alive) return;
      closeCreate(); saveDraft(); farmEpoch++; threadEpoch++; stopPoll(); farmLoading = false; threadLoading = false;
      farm = farms.find(row => row.id === farmId) || null; farmSelect.value = farm?.id || ''; selected = null; conversations = []; members = [];
      available = false; memberReady = false; clearError(); clearThread(); updateHeader(); renderConversations(); renderLinks(); root.classList.remove('fm-thread-open'); notifyFarm();
      if (!farm) { status.textContent = 'Select a farm workspace.'; return; }
      await loadDirectory(); schedulePoll();
    }
    async function loadDirectory() {
      if (!alive || !active || !farm || farmLoading) return;
      const fe = farmEpoch, fid = farm.id; farmLoading = true; status.textContent = 'Refreshing farm conversations...';
      const result = await Promise.allSettled([request('conversation.list', { farmId: fid }), request('member.list', { farmId: fid }), request('department.list', { farmId: fid })]);
      if (!current(fe)) return;
      farmLoading = false;
      try {
        if (result[0].status !== 'fulfilled') throw result[0].reason;
        conversations = items(result[0].value); available = true;
        if (result[1].status === 'fulfilled') { members = items(result[1].value); memberReady = true; }
        else { memberReady = false; members = []; }
        departments = result[2].status === 'fulfilled' ? items(result[2].value) : [];
        if (selected) {
          const row = conversations.find(c => c.id === selected.id);
          if (!row) { threadEpoch++; selected = null; clearThread(); }
          else selected = row;
        }
        status.textContent = memberReady ? 'Connected to farm messaging' : 'Conversations connected. Member directory unavailable.';
        clearError();
      } catch (err) { available = false; status.textContent = 'Connection unavailable. Loaded records may be out of date.'; showError(err); }
      renderConversations(); updateHeader(); updateComposer();
    }
    async function chooseConversation(conversationId, focus) {
      if (!alive) return;
      saveDraft(); selected = conversations.find(row => row.id === conversationId) || null; threadEpoch++; threadLoading = false;
      clearError(); clearThread(); updateHeader(); renderConversations(); root.classList.toggle('fm-thread-open', !!selected);
      if (focus && selected) title.focus({ preventScroll: true });
      await loadMessages(true);
    }
    let historySignature = '';
    async function loadMessages(initial = false) {
      if (!alive || !active || !farm || !selected || threadLoading) return;
      const fe = farmEpoch, te = threadEpoch, fid = farm.id, cid = selected.id;
      threadLoading = true;
      try {
        more.disabled = true;
        const data = await request('message.list', { farmId: fid, conversationId: cid, afterSequence: latestSequence, limit: 200 });
        if (!current(fe, te)) return;
        const incoming = items(data);
        const merged = new Map(messageRows.map(row => [row.id, row]));
        for (const row of incoming) merged.set(row.id, row);
        const rows = [...merged.values()].sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
        messageRows = rows;
        more.hidden = data?.hasMore === false || (data?.hasMore !== true && incoming.length < 200);
        const key = keyFor(fid, cid), pending = attempts.get(key) || [];
        for (const row of rows) {
          const attempt = pending.find(attempt => row.requestId && row.requestId === attempt.requestId && row.text === attempt.body && !!selfId() && (row.authorId || row.author?.id) === selfId());
          if (attempt) {
            attempt.state = 'accepted'; attempt.confirmed = true;
            if (drafts.get(key) === attempt.body) drafts.delete(key);
            if (input.value === attempt.body) input.value = '';
          }
        }
        messageReady = true; available = true; latestSequence = rows.reduce((max, row) => Number.isSafeInteger(row.sequence) && row.sequence >= 0 ? Math.max(max, row.sequence) : max, 0);
        const signature = JSON.stringify(rows);
        if (initial || signature !== historySignature) {
          const atBottom = nearBottom(), previousTop = thread.scrollTop;
          history.replaceChildren(...rows.map(renderMessage)); historySignature = signature; empty.hidden = rows.length > 0;
          if (!rows.length) empty.replaceChildren(el('h3', {}, 'No messages yet'), caption('Start the conversation. Only server records appear in this history.'));
          renderOutbox();
          if (initial || atBottom) thread.scrollTop = thread.scrollHeight;
          else { thread.scrollTop = previousTop; jump.hidden = false; }
          announce.textContent = initial ? `${rows.length} messages loaded.` : 'Message history updated.';
        } else renderOutbox();
        status.textContent = 'Connected to farm messaging'; clearError(); updateComposer(); markRead();
      } catch (err) {
        if (current(fe, te)) { available = false; status.textContent = 'Message connection unavailable'; showError(err);
          if (initial) empty.replaceChildren(el('h3', {}, 'Messages unavailable'), caption('Refresh to reconnect. Your local draft is retained.'));
          renderOutbox(); updateComposer(); }
      } finally { if (current(fe, te)) { threadLoading = false; more.disabled = false; } }
    }
    function renderMessage(message) {
      const member = members.find(row => row.id === (message.authorId || message.author?.id));
      const author = member || message.author;
      const mine = !!selfId() && (message.authorId || message.author?.id) === selfId();
      const li = el('li', { className: `fm-message${mine ? ' fm-mine' : ''}`, 'data-message': message.id });
      const who = identity(author), at = timestamp(message.createdAt);
      const meta = el('p', { className: 'fm-message-meta' }, who, author?.kind === 'crowe-logic' ? ' / software participant' : '', at ? ` · ${at}` : ' · Time not supplied');
      const bubble = el('div', { className: 'fm-bubble' }, el('p', { className: 'fm-message-body' }, text(message.text, BODY_LIMIT)));
      const cards = Array.isArray(message.records) ? message.records : [];
      if (typeof api?.openRecord === 'function' && farm?.capabilities?.recordCards === true) {
        for (const card of cards.slice(0, 8)) if (card && RECORD_KINDS.has(card.kind) && id(card.recordId)) bubble.append(recordButton(card, 'Open staff record'));
      }
      li.append(meta, bubble);
      if (mine) {
        // Only explicit, per-recipient receipts count. A later reply or a
        // successful message.read (our own cursor) says nothing about delivery.
        const readers = Array.isArray(message.readBy) ? message.readBy.filter(receipt => receipt && id(receipt.memberId) && receipt.memberId !== selfId() && timestamp(receipt.readAt)) : [];
        li.append(el('p', { className: 'fm-receipt' }, readers.length ? `Read by ${readers.map(receipt => identity(members.find(member => member.id === receipt.memberId)) + ' · ' + timestamp(receipt.readAt)).join('; ')}` : 'Server accepted. No read receipt supplied.'));
      }
      return li;
    }
    function renderOutbox() {
      const key = currentKey(), records = attempts.get(key) || [], oldTop = thread.scrollTop;
      outbox.replaceChildren();
      for (const attempt of records.filter(row => !row.confirmed)) {
        const label = attempt.state === 'sending' ? 'Sending...' : attempt.state === 'accepted' ? 'Server accepted. Waiting for history. No read receipt supplied.' : 'Not confirmed. This may already have reached the server.';
        const li = el('li', { className: 'fm-message fm-mine fm-attempt', 'data-attempt': attempt.requestId });
        li.append(el('p', { className: 'fm-message-meta' }, 'Your send attempt'), el('div', { className: 'fm-bubble' }, el('p', { className: 'fm-message-body' }, attempt.body)), el('p', { className: 'fm-receipt' }, label));
        if (attempt.state === 'uncertain') li.append(button('Retry same message', () => dispatch(attempt), { 'data-retry': attempt.requestId }), caption(attempt.error || 'Retry keeps the original request ID.'));
        outbox.append(li);
      }
      thread.scrollTop = oldTop;
    }
    function sendDraft() {
      const body = input.value, key = currentKey();
      if (!alive || !active || !key || !body.trim() || body.length > BODY_LIMIT) return;
      const records = attempts.get(key) || [];
      const prior = records.find(row => row.body === body && !row.confirmed && row.state !== 'accepted');
      if (prior) { if (prior.state === 'uncertain') dispatch(prior); return; }
      try {
        const attempt = { farmId: farm.id, conversationId: selected.id, requestId: requestId(), body, state: 'new', confirmed: false };
        records.push(attempt); attempts.set(key, records); dispatch(attempt);
      } catch (err) { showError(err); }
    }
    async function dispatch(attempt) {
      if (!alive || attempt.state === 'sending' || attempt.state === 'accepted' || attempt.confirmed) return;
      const key = keyFor(attempt.farmId, attempt.conversationId);
      attempt.state = 'sending'; attempt.error = ''; if (currentKey() === key) { renderOutbox(); updateComposer(); }
      try {
        await request('message.send', { farmId: attempt.farmId, conversationId: attempt.conversationId, requestId: attempt.requestId, text: attempt.body });
        if (!alive) return;
        attempt.state = 'accepted';
        // A send result belongs to its immutable scope even after navigation.
        // Never erase a replacement draft entered while a request was pending.
        if (drafts.get(key) === attempt.body) drafts.delete(key);
        if (currentKey() === key) { if (input.value === attempt.body) input.value = ''; announce.textContent = 'Server accepted your message. This is not a read receipt.'; updateComposer(); renderOutbox(); await loadMessages(); }
      } catch (err) {
        if (!alive || attempt.confirmed) return;
        attempt.state = 'uncertain'; attempt.error = err.message;
        if (currentKey() === key) { renderOutbox(); announce.textContent = 'Send not confirmed. Retry the same message to keep its request ID.'; }
      }
    }
    function nearBottom() { return thread.scrollHeight - thread.clientHeight - thread.scrollTop < 48; }
    async function markRead() {
      if (!alive || !active || !selected || !messageReady || readBusy || !latestSequence || !more.hidden || dialog || !nearBottom() || doc.visibilityState !== 'visible' || !doc.hasFocus() || !thread.getClientRects().length) return;
      const fe = farmEpoch, te = threadEpoch, key = currentKey(), sequence = latestSequence;
      if ((readSequences.get(key) || 0) >= sequence) return;
      readBusy = true;
      try {
        const fingerprint = key + ':' + sequence;
        if (!readIntents.has(fingerprint)) readIntents.set(fingerprint, requestId());
        await request('message.read', { farmId: farm.id, conversationId: selected.id, sequence, requestId: readIntents.get(fingerprint) });
        if (!alive) return; readSequences.set(key, sequence);
        if (current(fe, te)) { selected.unreadCount = 0; renderConversations(); }
      } catch (_) { /* A failed own-read cursor must not invent another person's receipt. */ }
      finally { if (current(fe, te)) readBusy = false; }
    }
    thread.addEventListener('scroll', () => { if (nearBottom()) { jump.hidden = true; markRead(); } });
    listen(doc, 'visibilitychange', () => { if (doc.visibilityState === 'visible') { markRead(); schedulePoll(); } else stopPoll(); });
    listen(win, 'focus', markRead);
    function stopPoll() { if (timer !== null) win.clearTimeout(timer); timer = null; }
    function schedulePoll() {
      stopPoll(); if (!alive || !active || !farm || doc.visibilityState === 'hidden') return;
      timer = win.setTimeout(async () => {
        timer = null; const fe = farmEpoch;
        if (root.getClientRects().length) { await loadDirectory(); if (current(fe)) await loadMessages(); }
        if (current(fe)) schedulePoll();
      }, POLL_MS);
    }
    async function refresh() {
      if (!alive) return; retryConnection.disabled = true;
      if (!farm) await loadFarms(); else { await loadDirectory(); await loadMessages(!messageReady); }
      if (alive) { retryConnection.disabled = false; schedulePoll(); }
    }
    function closeCreate() {
      if (!dialog) return;
      const old = dialog; dialog = null; old.remove(); sidebar.inert = false; detail.inert = false; connection.inert = false;
      if (alive && active && newButton.isConnected) newButton.focus(); updateComposer();
    }
    function openCreate() {
      if (!alive || !active || !farm || !memberReady || !available || dialog || createDrafts.get(farm.id)?.busy) return;
      const fid = farm.id, fe = farmEpoch;
      const saved = createDrafts.get(fid) || { kind: 'direct', title: '', departmentId: '', memberIds: [], attempts: new Map(), busy: false };
      createDrafts.set(fid, saved);
      const modal = el('div', { className: 'fm-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${prefix}-create-title`, 'data-fm': 'create' });
      const form = el('form', { className: 'fm-create-form' });
      const close = button('Cancel', closeCreate);
      const kind = el('select', { id: `${prefix}-kind`, name: 'kind' });
      for (const [value, label] of [['direct', 'Direct message'], ['group', 'Group message'], ['department', 'Department alerts']]) kind.append(el('option', { value }, label));
      kind.value = saved.kind;
      const name = el('input', { id: `${prefix}-name`, name: 'title', maxlength: TITLE_LIMIT, value: saved.title });
      const department = el('select', { id: `${prefix}-department`, name: 'departmentId' }, el('option', { value: '' }, 'Select department'));
      for (const row of departments) if (row && id(row.id)) department.append(el('option', { value: row.id }, text(row.name, 120) || 'Unnamed department'));
      department.value = saved.departmentId;
      const deptLabel = el('label', { for: department.id }, 'Department');
      const fieldset = el('fieldset', { className: 'fm-member-options' }, el('legend', {}, 'Participants'));
      const choices = members.filter(row => row.id !== selfId() && row.active !== false), checks = [];
      for (const member of choices) {
        const check = el('input', { type: 'checkbox', name: 'memberIds', value: member.id, id: `${prefix}-member-${checks.length}` }); check.checked = saved.memberIds.includes(member.id);
        checks.push(check); fieldset.append(el('label', { for: check.id, className: 'fm-member-option' }, check, el('span', {}, identity(member), caption(member.kind === 'crowe-logic' ? 'Software participant. Select explicitly.' : text(member.role, 120) || 'Farm member'))));
      }
      if (!choices.length) fieldset.append(caption('No available members returned by the service. No sample contacts are added.'));
      const notice = el('p', { role: 'alert', className: 'fm-error', hidden: true });
      const submit = el('button', { type: 'submit', disabled: saved.busy }, saved.busy ? 'Creating...' : 'Create conversation');
      function preserve() { saved.kind = kind.value; saved.title = name.value; saved.departmentId = department.value; saved.memberIds = checks.filter(check => check.checked).map(check => check.value); }
      function fields() { const dept = kind.value === 'department'; department.hidden = !dept; deptLabel.hidden = !dept; name.required = kind.value !== 'direct'; department.required = dept; fieldset.hidden = dept; }
      form.addEventListener('input', preserve); form.addEventListener('change', () => { preserve(); fields(); }); fields();
      form.append(el('h2', { id: `${prefix}-create-title` }, 'New conversation'), caption('Choose who participates. Human messages are not routed to Crowe Logic unless that participant is explicitly included.'),
        el('label', { for: kind.id }, 'Conversation type'), kind, el('label', { for: name.id }, 'Title (optional for direct messages)'), name, deptLabel, department, fieldset, notice,
        el('div', { className: 'fm-modal-actions' }, close, submit));
      modal.append(form); dialog = modal; root.append(modal); sidebar.inert = true; detail.inert = true; connection.inert = true; kind.focus();
      modal.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); closeCreate(); }
        if (event.key === 'Tab') {
          const focusable = [...modal.querySelectorAll('button, input, select')].filter(node => !node.disabled && !node.hidden && node.getClientRects().length);
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      });
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (!current(fe) || saved.busy) return; preserve();
        const memberIds = saved.memberIds.slice().sort(), titleValue = saved.title.trim();
        const fail = message => { notice.hidden = false; notice.textContent = message; };
        if (!['direct', 'group', 'department'].includes(saved.kind)) return fail('Choose a conversation type.');
        if (saved.kind !== 'department' && (!memberIds.length || memberIds.length > 100 || memberIds.some(value => !choices.some(member => member.id === value)))) return fail('Choose between 1 and 100 available participants.');
        if (saved.kind === 'direct' && memberIds.length !== 1) return fail('A direct message needs exactly one other participant.');
        if (titleValue.length > TITLE_LIMIT || (saved.kind !== 'direct' && !titleValue)) return fail('Give this conversation a title of 120 characters or fewer.');
        if (saved.kind === 'department' && !departments.some(row => row.id === saved.departmentId)) return fail('Select an available department.');
        const payload = { farmId: fid, kind: saved.kind, title: titleValue, ...(saved.kind === 'department' ? { departmentId: saved.departmentId } : { participantIds: memberIds }) };
        const fingerprint = JSON.stringify(payload);
        let intent = saved.attempts.get(fingerprint);
        try { if (!intent) { intent = { ...payload, requestId: requestId() }; saved.attempts.set(fingerprint, intent); } }
        catch (err) { return fail(err.message); }
        saved.busy = true; submit.disabled = true; submit.textContent = 'Creating...'; notice.hidden = true;
        for (const control of [kind, name, department, ...checks]) control.disabled = true;
        try {
          const result = await request('conversation.create', intent);
          if (!alive) return;
          saved.busy = false;
          const conversation = result?.conversation || result;
          if (!id(conversation?.id)) throw new Error('Creation result has no conversation ID. Retry with the same choices to reuse its request ID.');
          createDrafts.delete(fid);
          if (current(fe)) { if (dialog === modal) closeCreate(); await loadDirectory(); if (current(fe) && active) await chooseConversation(conversation.id, true); }
        } catch (err) { if (alive) { saved.busy = false; updateComposer(); if (dialog === modal && current(fe)) { submit.disabled = false; submit.textContent = 'Retry creation'; fail('Creation not confirmed. ' + err.message); } } }
      });
    }
    renderLinks(); loadFarms();
    return {
      currentSelection: selection,
      open() { if (!alive) return; active = true; root.hidden = false; refresh(); },
      deactivate() { if (!alive) return; active = false; saveDraft(); closeCreate(); stopPoll(); root.hidden = true; },
      destroy() {
      if (!alive) return; alive = false; farmEpoch++; threadEpoch++; farmListEpoch++; stopPoll();
      for (const cancel of [...cancellations]) cancel(); for (const remove of listeners) remove();
      closeCreate(); drafts.clear(); attempts.clear(); createDrafts.clear(); readSequences.clear(); readIntents.clear(); farmCreateIntents.clear();
      farms = []; conversations = []; members = []; farm = null; selected = null; input.value = ''; farmName.value = ''; root.remove(); notifyFarm();
    } };
  }
  return { mount, BODY_LIMIT, TITLE_LIMIT };
});
