/* WordRush frontend. It only DISPLAYS the game and SENDS requests.
   Letters, round ending, locking and scoring all happen on the server (Supabase SQL functions). */
(() => {
  'use strict';

  const CFG = window.WORDRUSH_CONFIG;
  const $ = (id) => document.getElementById(id);
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  // ---------- state ----------
  let me = null, roomId = null, roomCode = null, S = null, categories = [], channel = null;
  let hbTimer = null, tickTimer = null, pollTimer = null, refreshTimer = null, toastTimer = null;
  let clockOffset = 0, refreshSeq = 0, expiryCalledFor = null, builtRound = null;
  let settingsSig = '', settingsDirty = false, currentView = 'home';
  let chat = [], unread = 0, chatOpen = false;
  const timers = {};

  // ---------- tiny helpers ----------
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };
  const debounce = (key, fn, ms) => { clearTimeout(timers[key]); timers[key] = setTimeout(fn, ms); };
  const serverNow = () => Date.now() + clockOffset;
  const fmt = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const catLabel = (id) => (categories.find((c) => c.id === id) || {}).label || id;
  const nick = (uid) => (S && S.nicknames && S.nicknames[uid]) || 'Player';
  const inviteLink = (code) => location.origin + location.pathname + '?room=' + code;

  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (kind === 'ok' ? ' ok' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }

  function friendly(error) {
    const m = (error && error.message) || '';
    if (/failed to fetch|network|load failed/i.test(m)) return 'Cannot reach the server. Check your internet connection.';
    if (/permission denied/i.test(m)) return 'That action is not allowed.';
    return 'Something went wrong: ' + m;
  }

  // Calls a server function. Returns {ok:true,...} or {ok:false,error,message}.
  async function rpc(name, args, opts) {
    const silent = opts && opts.silent;
    let res;
    try { res = await sb.rpc(name, args); }
    catch (e) { res = { error: e }; }
    if (res.error) {
      if (!silent) toast(friendly(res.error));
      return { ok: false, error: 'network', message: friendly(res.error) };
    }
    const data = res.data || { ok: false, error: 'empty', message: 'No answer from the server.' };
    if (data.ok === false && !silent) toast(data.message || 'That did not work.');
    return data;
  }

  // ---------- views ----------
  function show(view) {
    for (const v of ['home', 'lobby', 'game', 'results']) $('view-' + v).hidden = v !== view;
    $('chat').hidden = view === 'home';
    $('leave-btn').hidden = view === 'home';
    if (view !== currentView) { window.scrollTo(0, 0); currentView = view; }
  }

  function setConn(ok) { $('conn').hidden = ok; }

  // ---------- boot ----------
  async function ensureUser() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) { me = session.user.id; return; }
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) throw error;
    me = data.session.user.id;
  }

  async function loadCategories() {
    const { data } = await sb.from('categories').select('id,label,enabled,sort_order').order('sort_order');
    categories = data || [];
  }

  async function boot() {
    show('home');
    $('nick-input').value = localStorage.getItem('wordrush_nick') || '';
    const invited = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
    if (invited) $('code-input').value = invited;

    try { await ensureUser(); }
    catch (e) {
      toast('Guest sign-in failed. Check that anonymous sign-ins are enabled in Supabase. ' + (e.message || ''));
      return;
    }
    await loadCategories();

    const saved = JSON.parse(localStorage.getItem('wordrush_room') || 'null');
    if (saved && (!invited || invited === saved.code)) {
      const r = await rpc('get_room_state', { p_room_id: saved.id }, { silent: true });
      if (r.ok) { await enterRoom(saved.id, saved.code); return; }
      localStorage.removeItem('wordrush_room');
    }
    if (invited) previewJoin();
  }

  // ---------- home actions ----------
  function getNick() {
    const n = $('nick-input').value.trim();
    if (n.length < 1 || n.length > 20) { toast('Enter a nickname (1 to 20 characters).'); $('nick-input').focus(); return null; }
    localStorage.setItem('wordrush_nick', n);
    return n;
  }

  async function withBusy(btn, fn) {
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  }

  $('create-btn').addEventListener('click', () => withBusy($('create-btn'), async () => {
    const n = getNick(); if (!n) return;
    const r = await rpc('create_room', { p_nickname: n });
    if (r.ok) await enterRoom(r.room_id, r.code);
  }));

  async function previewJoin() {
    const code = $('code-input').value.trim().toUpperCase();
    $('join-preview').hidden = true;
    if (!code) { toast('Enter a room code.'); return; }
    const r = await rpc('get_room_by_code', { p_code: code });
    if (!r.ok) return;
    let text = 'Room ' + r.code + '. Host: ' + (r.host || 'unknown') + '. Players: ' + r.players + '/' + r.max_players + '.';
    if (r.status !== 'lobby') text += ' A game is already in progress (only players who were already in it can rejoin).';
    else if (!r.joinable) text += ' This room is full.';
    $('join-preview-text').textContent = text;
    $('join-preview').hidden = false;
  }
  $('join-btn').addEventListener('click', () => withBusy($('join-btn'), previewJoin));

  $('join-confirm').addEventListener('click', () => withBusy($('join-confirm'), async () => {
    const n = getNick(); if (!n) return;
    const code = $('code-input').value.trim().toUpperCase();
    const r = await rpc('join_room', { p_code: code, p_nickname: n });
    if (r.ok) await enterRoom(r.room_id, r.code);
  }));

  $('code-input').addEventListener('input', () => { $('join-preview').hidden = true; });

  // ---------- entering / leaving a room ----------
  async function enterRoom(id, code) {
    roomId = id; roomCode = code;
    localStorage.setItem('wordrush_room', JSON.stringify({ id, code }));
    history.replaceState(null, '', location.pathname + '?room=' + code);
    chat = []; unread = 0; builtRound = null; settingsSig = ''; settingsDirty = false; expiryCalledFor = null; S = null;
    await loadChatHistory();
    subscribe();
    startTimers();
    await refresh();
  }

  function goHome() {
    stopTimers();
    if (channel) { sb.removeChannel(channel); channel = null; }
    roomId = null; roomCode = null; S = null; builtRound = null;
    localStorage.removeItem('wordrush_room');
    history.replaceState(null, '', location.pathname);
    $('room-pill').hidden = true;
    $('end-btn').hidden = true;
    $('conn').hidden = true;
    $('join-preview').hidden = true;
    show('home');
  }

  $('leave-btn').addEventListener('click', async () => {
    if (!confirm('Leave this room?')) return;
    await rpc('leave_room', { p_room_id: roomId }, { silent: true });
    goHome();
  });

  $('end-btn').addEventListener('click', async () => {
    if (!confirm('End the game for everyone and return to the lobby?')) return;
    const r = await rpc('cancel_game', { p_room_id: roomId });
    if (r.ok) { builtRound = null; refresh(); }
  });

  // ---------- realtime ----------
  function subscribe() {
    if (channel) sb.removeChannel(channel);
    const byRoom = 'room_id=eq.' + roomId;
    channel = sb.channel('room-' + roomId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: 'id=eq.' + roomId }, queueRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: byRoom }, queueRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds', filter: byRoom }, queueRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'round_players' }, queueRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rematch_votes' }, queueRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: byRoom },
        (p) => onChat(p.new))
      .subscribe((status) => {
        setConn(status === 'SUBSCRIBED');
        if (status === 'SUBSCRIBED') queueRefresh();
      });
  }

  function queueRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); }

  function startTimers() {
    stopTimers();
    heartbeat();
    hbTimer = setInterval(heartbeat, 10000);
    tickTimer = setInterval(tick, 250);
    pollTimer = setInterval(refresh, 12000);
  }
  function stopTimers() { clearInterval(hbTimer); clearInterval(tickTimer); clearInterval(pollTimer); clearTimeout(refreshTimer); }

  async function heartbeat() {
    if (!roomId) return;
    const r = await rpc('heartbeat', { p_room_id: roomId }, { silent: true });
    if (!roomId) return;
    if (r.error === 'network') { setConn(false); return; }
    if (!r.ok && (r.error === 'not_member' || r.error === 'room_closed')) { toast(r.message); goHome(); return; }
    if (r.ok && S && S.room.host_id !== r.host_id) queueRefresh();
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden && roomId) { heartbeat(); refresh(); } });
  window.addEventListener('online', () => { if (roomId) { heartbeat(); refresh(); } });
  window.addEventListener('offline', () => setConn(false));

  async function refresh() {
    if (!roomId) return;
    const seq = ++refreshSeq;
    const r = await rpc('get_room_state', { p_room_id: roomId }, { silent: true });
    if (seq !== refreshSeq || !roomId) return;
    if (!r.ok) {
      if (r.error === 'not_member') { toast('You are no longer in this room.'); goHome(); }
      else if (r.error === 'network') setConn(false);
      return;
    }
    setConn(true);
    S = r;
    clockOffset = Date.parse(r.server_now) - Date.now();
    render();
  }

  // ---------- render dispatcher ----------
  function render() {
    const room = S.room;
    if (room.status === 'closed') { toast('This room was closed.'); goHome(); return; }
    let view = 'lobby';
    if (room.status === 'playing' && S.round) view = 'game';
    else if ((room.status === 'results' || room.status === 'finished') && S.round) view = 'results';
    show(view);
    $('room-pill').textContent = room.code;
    $('room-pill').hidden = false;
    $('end-btn').hidden = !(room.host_id === me && (room.status === 'playing' || room.status === 'results'));
    if (view === 'lobby') renderLobby();
    else if (view === 'game') renderGame();
    else renderResults();
  }

  function renderMembers(ul, showSubmitted) {
    clear(ul);
    for (const m of S.members) {
      const p = showSubmitted ? S.players.find((x) => x.user_id === m.user_id) : null;
      ul.append(el('li', null,
        el('span', { class: 'dot' + (m.connected ? ' on' : ''), role: 'img', 'aria-label': m.connected ? 'Connected' : 'Offline' }),
        el('span', { class: 'grow', text: m.nickname + (m.user_id === me ? ' (you)' : '') }),
        m.is_host ? el('span', { class: 'tag', text: 'Host' }) : null,
        !m.connected ? el('span', { class: 'muted', text: 'offline' }) : null,
        showSubmitted && p ? el('span', { class: 'tag light', text: p.submitted ? '✓ Submitted' : 'Writing…' }) : null
      ));
    }
  }

  // ---------- lobby ----------
  function renderLobby() {
    const room = S.room, isHost = room.host_id === me;
    $('lobby-code').textContent = room.code;
    $('invite-link').value = inviteLink(room.code);
    $('lobby-count').textContent = '(' + S.members.length + '/' + room.max_players + ')';
    renderMembers($('lobby-members'), false);
    $('start-btn').hidden = !isHost;
    $('start-btn').disabled = S.members.length < 2;
    $('start-hint').textContent = isHost
      ? (S.members.length < 2 ? 'Waiting for at least one more player…' : 'Ready when you are!')
      : 'Waiting for the host to start the game…';
    renderSettings(isHost);
  }

  $('copy-btn').addEventListener('click', async () => {
    const input = $('invite-link');
    try { await navigator.clipboard.writeText(input.value); toast('Invite link copied', 'ok'); }
    catch (e) { input.select(); document.execCommand('copy'); toast('Invite link copied', 'ok'); }
  });

  $('start-btn').addEventListener('click', () => withBusy($('start-btn'), async () => {
    if (settingsDirty) { toast('Tap "Save settings" first so your changes are used.'); return; }
    const r = await rpc('start_game', { p_room_id: roomId });
    if (r.ok) refresh();
  }));

  function renderSettings(isHost) {
    const room = S.room, box = $('settings');
    const shownCats = categories.filter((c) => c.enabled);
    if (!isHost) {
      settingsSig = '';
      clear(box);
      box.append(el('ul', { class: 'summary-list' },
        el('li', { text: 'Rounds: ' + room.rounds_total }),
        el('li', { text: 'Seconds per round: ' + room.round_seconds }),
        el('li', { text: 'Max players: ' + room.max_players }),
        el('li', { text: 'Categories: ' + room.category_ids.map(catLabel).join(', ') }),
        el('li', { text: 'Letters: ' + room.letter_pool }),
        el('li', { text: room.allow_repeat ? 'Letters may repeat' : 'No repeated letters until all are used' })
      ));
      return;
    }
    const sig = JSON.stringify([room.rounds_total, room.round_seconds, room.max_players, room.category_ids, room.allow_repeat, room.letter_pool, 'host']);
    if (sig === settingsSig || settingsDirty) return;
    settingsSig = sig;
    clear(box);
    const num = (id, label, val, min, max) => [
      el('label', { for: id, text: label }),
      el('input', { id, type: 'number', inputmode: 'numeric', min, max, value: val })
    ];
    const form = el('form', { class: 'settings-form', onsubmit: saveSettings },
      num('s-rounds', 'Number of rounds (1 to 26)', room.rounds_total, 1, 26),
      num('s-seconds', 'Seconds per round (20 to 300)', room.round_seconds, 20, 300),
      num('s-max', 'Maximum players (2 to 20)', room.max_players, 2, 20),
      el('label', { for: 's-pool', text: 'Letters to use' }),
      el('input', { id: 's-pool', type: 'text', maxlength: '26', value: room.letter_pool, autocapitalize: 'characters', autocomplete: 'off' }),
      el('p', { class: 'hint', text: 'Keep all 26 letters, or remove hard ones like Q, X, Z.' }),
      el('label', { class: 'check', for: 's-repeat' },
        el('input', { id: 's-repeat', type: 'checkbox', checked: room.allow_repeat }),
        'Allow letters to repeat before the alphabet is used up'),
      el('fieldset', null,
        el('legend', { text: 'Categories' }),
        shownCats.map((c) => el('label', { class: 'check', for: 'cat-' + c.id },
          el('input', { id: 'cat-' + c.id, type: 'checkbox', 'data-cat': c.id, checked: room.category_ids.includes(c.id) }),
          c.label))),
      el('button', { class: 'btn secondary big', type: 'submit', text: 'Save settings' })
    );
    form.addEventListener('input', () => { settingsDirty = true; });
    box.append(form);
  }

  async function saveSettings(e) {
    e.preventDefault();
    const cats = [...document.querySelectorAll('#settings input[data-cat]')].filter((i) => i.checked).map((i) => i.dataset.cat);
    const r = await rpc('update_settings', {
      p_room_id: roomId,
      p_rounds: parseInt($('s-rounds').value, 10),
      p_seconds: parseInt($('s-seconds').value, 10),
      p_max: parseInt($('s-max').value, 10),
      p_categories: cats,
      p_allow_repeat: $('s-repeat').checked,
      p_letter_pool: $('s-pool').value
    });
    if (r.ok) { settingsDirty = false; settingsSig = ''; toast('Settings saved', 'ok'); refresh(); }
  }

  // ---------- game ----------
  function renderGame() {
    const rd = S.round, g = S.game;
    $('game-round').textContent = rd.is_tiebreaker ? 'Tiebreaker round' : 'Round ' + rd.round_number + ' of ' + g.rounds_total;
    const L = $('game-letter');
    if (L.textContent !== rd.letter) {
      L.textContent = rd.letter;
      L.classList.remove('pop'); void L.offsetWidth; L.classList.add('pop');
    }
    if (builtRound !== rd.id) { buildForm(rd); builtRound = rd.id; }
    renderMembers($('game-members'), true);
    $('spectator').hidden = S.players.some((p) => p.user_id === me);
    updateGameDynamic();
  }

  function buildForm(rd) {
    const box = $('answers');
    clear(box);
    for (const cat of rd.category_ids) {
      const input = el('input', {
        id: 'ans-' + cat, type: 'text', maxlength: '80', autocomplete: 'off', autocapitalize: 'words',
        spellcheck: 'false', enterkeyhint: 'next', 'data-cat': cat
      });
      input.value = (S.my_answers && S.my_answers[cat]) || '';
      input.addEventListener('input', () => onType(cat, input));
      input.addEventListener('blur', () => { checkField(cat, input); saveDraft(); });
      box.append(el('div', { class: 'field' },
        el('label', { for: 'ans-' + cat, text: catLabel(cat) }),
        input,
        el('div', { class: 'fb', id: 'fb-' + cat, 'aria-live': 'polite' })));
      if (input.value) checkField(cat, input);
    }
  }

  function setFb(cat, kind, text) {
    const f = $('fb-' + cat);
    if (!f) return;
    f.className = 'fb' + (kind ? ' ' + kind : '');
    f.textContent = text;
  }

  function onType(cat, input) {
    setFb(cat, '', '');
    input.classList.remove('invalid');
    debounce('chk-' + cat, () => checkField(cat, input), 500);
    debounce('draft', saveDraft, 700);
    updateGameDynamic();
  }

  async function checkField(cat, input) {
    const v = input.value.trim();
    if (!v) { setFb(cat, '', ''); return; }
    if (!S || !S.round) return;
    const rid = S.round.id;
    const r = await rpc('check_answer', { p_round_id: rid, p_category_id: cat, p_text: v }, { silent: true });
    if (!S || !S.round || S.round.id !== rid || input.value.trim() !== v || !r.ok) return;
    setFb(cat, r.valid ? 'ok' : 'bad', (r.valid ? '✓ ' : '✗ ') + r.message);
  }

  function collect() {
    const out = {};
    document.querySelectorAll('#answers input').forEach((i) => { out[i.dataset.cat] = i.value; });
    return out;
  }

  async function saveDraft() {
    if (!S || !S.round || S.room.status !== 'playing') return;
    const rid = S.round.id;
    const r = await rpc('save_draft', { p_round_id: rid, p_answers: collect() }, { silent: true });
    if (!r.ok && r.error === 'round_ended') refresh();
  }

  function updateGameDynamic() {
    if (!S || !S.round || S.room.status !== 'playing') return;
    const rd = S.round, now = serverNow();
    const start = Date.parse(rd.starts_at), end = Date.parse(rd.ends_at);
    const mine = S.players.find((p) => p.user_id === me);
    const submitted = !!(mine && mine.submitted);
    const counting = now < start, over = now >= end;

    $('countdown').hidden = !counting;
    if (counting) $('countdown-num').textContent = Math.max(1, Math.ceil((start - now) / 1000));
    const secs = Math.max(0, Math.ceil((end - Math.max(now, start)) / 1000));
    $('timer').textContent = fmt(secs);
    $('timer').classList.toggle('low', !counting && secs <= 10);
    $('bar-fill').style.width = (counting ? 100 : Math.max(0, Math.min(100, ((end - now) / (end - start)) * 100))) + '%';

    const locked = !mine || submitted || counting || over;
    document.querySelectorAll('#answers input').forEach((i) => { i.disabled = locked; });

    const vals = collect();
    const missing = rd.category_ids.filter((c) => !(vals[c] || '').trim());
    $('submit-btn').disabled = locked || missing.length > 0;
    $('submit-hint').textContent = !mine ? 'You are watching this round.'
      : submitted ? 'Submitted. Waiting for the round to finish…'
      : counting ? 'Get ready. Typing starts in a moment.'
      : over ? 'Time is up. Answers are locked.'
      : missing.length ? 'Still needed: ' + missing.map(catLabel).join(', ')
      : 'Ready to submit. The first submission ends the round for everyone.';

    if (over && expiryCalledFor !== rd.id) { expiryCalledFor = rd.id; endIfExpired(rd.id); }
  }

  function tick() { updateGameDynamic(); }

  async function endIfExpired(rid) {
    await rpc('end_round_if_expired', { p_round_id: rid }, { silent: true });
    await refresh();
    setTimeout(() => { if (S && S.round && S.round.id === rid && S.room.status === 'playing') expiryCalledFor = null; }, 1500);
  }

  $('submit-btn').addEventListener('click', async () => {
    const btn = $('submit-btn');
    btn.disabled = true;
    clearTimeout(timers.draft);
    const r = await rpc('submit_answers', { p_round_id: S.round.id, p_answers: collect() });
    if (!r.ok && r.error === 'missing_answers' && r.missing) {
      r.missing.forEach((c) => { const i = $('ans-' + c); if (i) i.classList.add('invalid'); });
    }
    await refresh();
  });

  // ---------- results ----------
  function clientLetterOk(answer, letter) {
    const n = (answer || '').toLowerCase().replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/g, ' ').trim();
    return n.length > 0 && n[0].toUpperCase() === letter;
  }

  function renderResults() {
    const rd = S.round, g = S.game, room = S.room, isHost = room.host_id === me;
    const title = rd.is_tiebreaker ? 'Tiebreaker' : 'Round ' + rd.round_number + ' of ' + g.rounds_total;
    $('res-title').textContent = title + ' results. Letter ' + rd.letter;
    $('res-sub').textContent = (rd.end_reason === 'submission' ? nick(rd.ended_by) + ' submitted first'
      : rd.end_reason === 'timeout' ? 'Time ran out' : 'Round cancelled') + '. All answers are locked.';

    const catsBox = $('res-cats');
    clear(catsBox);
    if (S.results) {
      const players = S.players.map((p) => p.user_id).sort((a, b) => nick(a).localeCompare(nick(b)));
      for (const cat of rd.category_ids) {
        const ul = el('ul');
        for (const uid of players) {
          const a = S.results.find((x) => x.user_id === uid && x.category_id === cat) || { answer: '', points: 0 };
          const blank = !(a.answer || '').trim();
          let cls = 'bad', status = '✗ Not recognized (0)';
          if (blank) status = '✗ Blank (0)';
          else if (a.valid && a.duplicate) { cls = 'dup'; status = '= Duplicate (0)'; }
          else if (a.valid) { cls = 'ok'; status = '✓ Correct +' + a.points; }
          else if (!clientLetterOk(a.answer, rd.letter)) status = '✗ Wrong letter (0)';
          ul.append(el('li', { class: 'res-row ' + cls },
            el('div', null, el('div', { class: 'who', text: nick(uid) + (uid === me ? ' (you)' : '') }),
              el('div', { class: 'ans', text: blank ? '(no answer)' : a.answer })),
            el('div', { class: 'status', text: status })));
        }
        catsBox.append(el('div', { class: 'card res-cat' }, el('h3', { text: catLabel(cat) }), ul));
      }
    }

    const rb = $('round-board'); clear(rb);
    [...S.players].sort((a, b) => (b.round_score || 0) - (a.round_score || 0)).forEach((p) => {
      rb.append(el('li', null, nick(p.user_id) + (p.user_id === me ? ' (you)' : ''), el('span', { class: 'pts', text: (p.round_score || 0) + ' pts' })));
    });
    const tb = $('total-board'); clear(tb);
    S.totals.forEach((t) => {
      tb.append(el('li', null, nick(t.user_id) + (t.user_id === me ? ' (you)' : ''), el('span', { class: 'pts', text: t.total + ' pts' })));
    });

    const finished = room.status === 'finished';
    const wb = $('winner-banner');
    wb.hidden = !finished;
    if (finished) {
      const names = (g.winner_ids || []).map(nick);
      wb.textContent = '🏆 ' + (names.length > 1 ? 'Winners: ' : 'Winner: ') + names.join(' & ');
    }

    const tie = !finished && (rd.is_tiebreaker || rd.round_number >= g.rounds_total);
    $('tie-note').hidden = !tie;
    $('tie-note').textContent = tie ? 'It is a tie at the top! The host starts a tiebreaker round between the tied players.' : '';
    $('next-btn').hidden = !(isHost && !finished);
    $('next-btn').textContent = tie ? 'Start tiebreaker' : 'Next round';
    $('wait-host').hidden = isHost || finished;

    const rm = $('rematch');
    rm.hidden = !finished;
    if (finished) {
      const yes = S.rematch_votes.filter((v) => v.vote && S.members.some((m) => m.user_id === v.user_id)).length;
      const mine = S.rematch_votes.find((v) => v.user_id === me);
      $('rematch-text').textContent = yes + ' of ' + S.members.length + ' players want a rematch. It starts when more than half vote yes and the host is still in the room.'
        + (mine ? ' You voted ' + (mine.vote ? 'yes.' : 'no.') : '');
    }
  }

  $('next-btn').addEventListener('click', () => withBusy($('next-btn'), async () => {
    const r = await rpc('next_round', { p_room_id: roomId });
    if (r.ok) { builtRound = null; refresh(); }
  }));

  async function vote(v) {
    const r = await rpc('vote_rematch', { p_game_id: S.game.id, p_vote: v });
    if (r.ok && r.rematch_started) toast('Rematch starting!', 'ok');
    refresh();
  }
  $('vote-yes').addEventListener('click', () => vote(true));
  $('vote-no').addEventListener('click', () => vote(false));

  // ---------- chat ----------
  async function loadChatHistory() {
    const { data } = await sb.from('chat_messages').select('id,user_id,nickname,body,created_at')
      .eq('room_id', roomId).order('created_at', { ascending: true }).limit(100);
    chat = data || [];
    renderChat();
  }

  function onChat(m) {
    if (!m || chat.some((x) => x.id === m.id)) return;
    chat.push(m);
    if (chat.length > 200) chat.shift();
    if (!chatOpen && m.user_id !== me) unread++;
    renderChat();
  }

  function renderChat() {
    const b = $('chat-badge');
    b.hidden = unread === 0;
    b.textContent = unread;
    const ul = $('chat-list');
    clear(ul);
    for (const m of chat) {
      const t = new Date(m.created_at);
      ul.append(el('li', { class: m.user_id === me ? 'own' : '' },
        el('strong', { text: m.nickname }),
        el('time', { datetime: m.created_at, text: t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
        el('div', { text: m.body })));
    }
    ul.scrollTop = ul.scrollHeight;
  }

  $('chat-toggle').addEventListener('click', () => {
    chatOpen = !chatOpen;
    $('chat-panel').hidden = !chatOpen;
    $('chat-toggle').setAttribute('aria-expanded', String(chatOpen));
    if (chatOpen) { unread = 0; renderChat(); $('chat-input').focus(); }
  });

  $('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const body = input.value.trim();
    if (!body) return;
    const r = await rpc('send_chat', { p_room_id: roomId, p_body: body });
    if (r.ok) input.value = '';
  });

  // ---------- go ----------
  boot();
})();
