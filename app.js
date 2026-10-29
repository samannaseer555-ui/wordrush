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
  let clockOffset = 0, clockSet = false, refreshSeq = 0, expiryCalledFor = null, voteExpiryCalledFor = null, builtRound = null;
  let settingsSig = '', settingsDirty = false, currentView = 'home';
  let savePending = null, settingsVer = 0, normalizedFor = null;
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
  // Always the same fixed order as the category list, whatever order the host ticked them in.
  const orderCats = (ids) => {
    const known = categories.filter((c) => ids.includes(c.id)).map((c) => c.id);
    return known.concat(ids.filter((i) => !known.includes(i)));
  };
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

  // ---------- avatars (drawn from 3 small numbers, e.g. "2.5.1": colour, eyes, mouth) ----------
  const INK = '#26283a';
  const AV_COLORS = ['#e8a0a0', '#f0c58a', '#f2dc7c', '#a9d3a0', '#8fcfd0', '#9db7e0', '#c3a6d9', '#e3b4cf'];
  const EYES = [
    `<circle cx="39" cy="42" r="3.2" fill="${INK}"/><circle cx="61" cy="42" r="3.2" fill="${INK}"/>`,
    `<path d="M33 44 q6 -8 12 0"/><path d="M55 44 q6 -8 12 0"/>`,
    `<circle cx="39" cy="42" r="6" fill="#fff"/><circle cx="61" cy="42" r="6" fill="#fff"/><circle cx="40" cy="43" r="2.4" fill="${INK}" stroke="none"/><circle cx="62" cy="43" r="2.4" fill="${INK}" stroke="none"/>`,
    `<path d="M33 43 h12"/><path d="M55 43 h12"/>`,
    `<circle cx="39" cy="42" r="3.2" fill="${INK}"/><path d="M55 43 h12"/>`,
    `<circle cx="39" cy="44" r="3" fill="${INK}"/><circle cx="61" cy="44" r="3" fill="${INK}"/><path d="M32 35 l12 5"/><path d="M68 35 l-12 5"/>`,
    `<rect x="31" y="36" width="17" height="11" rx="3" fill="${INK}"/><rect x="52" y="36" width="17" height="11" rx="3" fill="${INK}"/><path d="M48 40 h4"/>`,
    `<path d="M34 37 l9 9 m0 -9 l-9 9"/><path d="M57 37 l9 9 m0 -9 l-9 9"/>`
  ];
  const MOUTHS = [
    `<path d="M39 56 q11 11 22 0"/>`,
    `<path d="M41 60 h18"/>`,
    `<ellipse cx="50" cy="60" rx="6" ry="5" fill="${INK}"/>`,
    `<path d="M39 56 q11 11 22 0"/><path d="M46 62 q4 8 8 0" fill="#e39a9a"/>`,
    `<path d="M41 60 q9 6 19 -4"/>`,
    `<path d="M39 63 q11 -10 22 0"/>`,
    `<path d="M38 58 l4 5 l4 -5 l4 5 l4 -5 l4 5 l4 -5"/>`,
    `<circle cx="50" cy="61" r="4"/>`
  ];
  const SHOULDERS = 'M10 100 Q10 72 50 72 Q90 72 90 100 Z';

  function parseAv(code) {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{1,2})$/.exec(code || '');
    const a = m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
    return a.map((n) => ((n % 8) + 8) % 8);
  }

  function avatarEl(code, size) {
    const [c, e, m] = parseAv(code);
    const col = AV_COLORS[c];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('class', 'avatar');
    svg.setAttribute('aria-hidden', 'true');
    // Only fixed drawing strings and numbers from the lists above are used here, never player text.
    svg.innerHTML =
      `<path d="${SHOULDERS}" fill="${col}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` +
      `<path d="${SHOULDERS}" fill="url(#hatch)"/>` +
      `<circle cx="50" cy="44" r="30" fill="${col}" stroke="${INK}" stroke-width="3"/>` +
      `<circle cx="50" cy="44" r="30" fill="url(#hatch)"/>` +
      `<g fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${EYES[e]}${MOUTHS[m]}</g>`;
    return svg;
  }
  const avFor = (uid) => avatarEl((S && S.avatars && S.avatars[uid]) || '0.0.0', 26);

  // ---------- friendly confirm dialog (replaces the plain browser popup) ----------
  function confirmBox(title, text, okLabel, cancelLabel, danger) {
    return new Promise((resolve) => {
      $('modal-title').textContent = title;
      $('modal-text').textContent = text;
      const ok = $('modal-ok'), cancel = $('modal-cancel');
      ok.textContent = okLabel;
      cancel.textContent = cancelLabel;
      ok.classList.toggle('danger-solid', !!danger);
      $('modal').hidden = false;
      cancel.focus();
      const finish = (v) => {
        $('modal').hidden = true;
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        resolve(v);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (e) => { if (e.key === 'Escape') finish(false); };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
    });
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
    $('topbar').hidden = view === 'home';
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
    if (invited) { $('code-input').value = invited; openJoinBox(); }
    drawStage();

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
    const r = await rpc('create_room', { p_nickname: n, p_avatar: avCode() });
    if (r.ok) await enterRoom(r.room_id, r.code);
  }));

  async function previewJoin() {
    const code = $('code-input').value.trim().toUpperCase();
    $('join-preview').hidden = true;
    if (!code) { toast('Enter a room code.'); return; }
    const r = await rpc('get_room_by_code', { p_code: code });
    if (!r.ok) return;
    let text = 'Room ' + r.code + '. Host: ' + (r.host || 'unknown') + '. Players: ' + r.players + '.';
    if (r.status !== 'lobby') text += ' A game is already in progress (only players who were already in it can rejoin).';
    else if (!r.joinable) text += ' This room is full.';
    $('join-preview-text').textContent = text;
    $('join-preview').hidden = false;
  }
  $('join-btn').addEventListener('click', () => withBusy($('join-btn'), previewJoin));

  $('join-confirm').addEventListener('click', () => withBusy($('join-confirm'), async () => {
    const n = getNick(); if (!n) return;
    const code = $('code-input').value.trim().toUpperCase();
    const r = await rpc('join_room', { p_code: code, p_nickname: n, p_avatar: avCode() });
    if (r.ok) await enterRoom(r.room_id, r.code);
  }));

  $('code-input').addEventListener('input', () => { $('join-preview').hidden = true; });

  // ---------- avatar picker ----------
  const rand8 = () => Math.floor(Math.random() * 8);
  const savedAv = localStorage.getItem('wordrush_avatar');
  let av = /^\d{1,2}\.\d{1,2}\.\d{1,2}$/.test(savedAv || '') ? parseAv(savedAv) : [rand8(), rand8(), rand8()];
  const avCode = () => av.join('.');
  function drawStage() {
    const st = $('avatar-stage');
    clear(st);
    st.append(avatarEl(avCode(), 150));
    localStorage.setItem('wordrush_avatar', avCode());
  }
  document.querySelectorAll('.arrow').forEach((b) => b.addEventListener('click', () => {
    const p = +b.dataset.part, d = +b.dataset.dir;
    av[p] = (av[p] + d + 8) % 8;
    drawStage();
  }));
  $('dice-btn').addEventListener('click', () => { av = [rand8(), rand8(), rand8()]; drawStage(); });

  function openJoinBox() {
    $('join-box').hidden = false;
    $('show-join').setAttribute('aria-expanded', 'true');
  }
  $('show-join').addEventListener('click', () => {
    const open = $('join-box').hidden;
    $('join-box').hidden = !open;
    $('show-join').setAttribute('aria-expanded', String(open));
    if (open) $('code-input').focus();
  });

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
    $('end-btn').hidden = true;
    $('conn').hidden = true;
    $('join-preview').hidden = true;
    show('home');
  }

  $('leave-btn').addEventListener('click', async () => {
    if (!(await confirmBox('Leave this room?', 'You can come back with the room code while the room is still open.', 'Leave', 'Stay', true))) return;
    await rpc('leave_room', { p_room_id: roomId }, { silent: true });
    goHome();
  });

  $('end-btn').addEventListener('click', async () => {
    if (!(await confirmBox('End the game?', 'The game stops for everyone and the room goes back to the lobby.', 'End game', 'Keep playing', true))) return;
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
    schedulePoll();
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      await refresh();
      if (roomId) schedulePoll();
    }, S && (S.room.status === 'playing' || S.room.status === 'voting') ? 3000 : 12000);
  }
  function stopTimers() { clearInterval(hbTimer); clearInterval(tickTimer); clearTimeout(pollTimer); clearTimeout(refreshTimer); }

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
    const t0 = Date.now();
    const r = await rpc('get_room_state', { p_room_id: roomId }, { silent: true });
    const t1 = Date.now();
    if (seq !== refreshSeq || !roomId) return;
    if (!r.ok) {
      if (r.error === 'not_member') { toast('You are no longer in this room.'); goHome(); }
      else if (r.error === 'network') setConn(false);
      return;
    }
    if (r.room && r.room.status === 'voting' && r.round) {
      const mv = await rpc('get_my_vote_items', { p_round_id: r.round.id }, { silent: true });
      if (seq !== refreshSeq || !roomId) return;
      r.my_vote_items = mv.ok ? mv.items : null;   // null = server not updated yet: fall back to the old list
    }
    setConn(true);
    S = r;
    // Estimate the server clock at the middle of the request. Skip slow replies so the estimate stays steady.
    // This is only for DISPLAY: the server alone decides when a round locks or ends.
    if (!clockSet || t1 - t0 <= 1500) { clockOffset = Date.parse(r.server_now) - (t0 + t1) / 2; clockSet = true; }
    render();
  }

  // ---------- render dispatcher ----------
  function render() {
    const room = S.room;
    if (room.status === 'closed') { toast('This room was closed.'); goHome(); return; }
    let view = 'lobby';
    if (room.status === 'playing' && S.round) view = 'game';
    else if ((room.status === 'results' || room.status === 'finished' || room.status === 'voting') && S.round) view = 'results';
    show(view);
    $('end-btn').hidden = !(room.host_id === me && (room.status === 'playing' || room.status === 'results' || room.status === 'voting'));
    if (view === 'lobby') renderLobby();
    else if (view === 'game') renderGame();
    else renderResults();
  }

  function renderMembers(ul, showSubmitted) {
    clear(ul);
    for (const m of S.members) {
      const p = showSubmitted ? S.players.find((x) => x.user_id === m.user_id) : null;
      ul.append(el('li', null,
        avatarEl(m.avatar, 36),
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
    $('lobby-count').textContent = '(' + S.members.length + ')';
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
    if (settingsDirty) { const saved = await flushSettings(); if (!saved) return; }
    const r = await rpc('start_game', { p_room_id: roomId });
    if (r.ok) refresh();
  }));

  const ROUND_OPTIONS = [3, 5, 7, 10];
  const FULL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const HIDDEN_MAX_PLAYERS = 20;   // no longer a setting; a fixed safety limit

  function renderSettings(isHost) {
    const room = S.room, box = $('settings');
    const shownCats = categories.filter((c) => c.enabled);
    if (!isHost) {
      settingsSig = '';
      clear(box);
      box.append(el('ul', { class: 'summary-list' },
        el('li', { text: 'Rounds: ' + room.rounds_total }),
        el('li', { text: 'Categories: ' + orderCats(room.category_ids).map(catLabel).join(', ') }),
        el('li', { text: room.allow_repeat ? 'Letters may repeat' : 'No repeated letters until all are used' }),
        el('li', { text: room.peer_voting ? 'Answers not in our list are checked by another player' : 'Answers are checked by our list only' }),
        el('li', { text: 'A round ends when someone submits, or automatically after 15 minutes' })
      ));
      return;
    }
    // Older rooms may still hold a player limit or letter list from before those options were removed.
    // Quietly bring them to the fixed values once.
    if ((room.max_players !== HIDDEN_MAX_PLAYERS || room.letter_pool !== FULL_ALPHABET) && normalizedFor !== room.id) {
      normalizedFor = room.id;
      pushSettings(true);
    }
    const sig = JSON.stringify([room.rounds_total, room.category_ids, room.allow_repeat, room.peer_voting, 'host']);
    if (sig === settingsSig || settingsDirty) return;
    settingsSig = sig;
    clear(box);
    const seg = el('div', { class: 'seg', role: 'group', 'aria-labelledby': 's-rounds-label' },
      ROUND_OPTIONS.map((n) => el('button', {
        type: 'button', class: 'seg-btn', 'data-rounds': String(n), 'aria-pressed': String(room.rounds_total === n), text: String(n),
        onclick: (e) => {
          seg.querySelectorAll('.seg-btn').forEach((b) => b.setAttribute('aria-pressed', 'false'));
          e.currentTarget.setAttribute('aria-pressed', 'true');
          autoSave();
        }
      })));
    const form = el('div', { class: 'settings-form' },
      el('label', { id: 's-rounds-label', text: 'Number of rounds' }),
      seg,
      el('p', { class: 'hint', text: 'Rounds have no countdown. A round ends when someone submits, or automatically after 15 minutes.' }),
      el('label', { class: 'check', for: 's-repeat' },
        el('input', { id: 's-repeat', type: 'checkbox', checked: room.allow_repeat }),
        'Allow letters to repeat before the alphabet is used up'),
      el('label', { class: 'check', for: 's-peer' },
        el('input', { id: 's-peer', type: 'checkbox', checked: room.peer_voting }),
        'Let players check answers that are not in our list'),
      el('fieldset', null,
        el('legend', { text: 'Categories' }),
        shownCats.map((c) => el('label', { class: 'check', for: 'cat-' + c.id },
          el('input', { id: 'cat-' + c.id, type: 'checkbox', 'data-cat': c.id, checked: room.category_ids.includes(c.id) }),
          c.label)))
    );
    form.addEventListener('change', autoSave);
    box.append(form);
  }

  // Reads the settings from the form (or from the room, if the form is not on screen).
  function readSettings() {
    const room = S.room;
    const rBtn = document.querySelector('#settings .seg-btn[aria-pressed="true"]');
    const catBoxes = [...document.querySelectorAll('#settings input[data-cat]')];
    return {
      rounds: rBtn ? parseInt(rBtn.dataset.rounds, 10) : room.rounds_total,
      cats: catBoxes.length ? catBoxes.filter((i) => i.checked).map((i) => i.dataset.cat) : room.category_ids,
      repeat: $('s-repeat') ? $('s-repeat').checked : room.allow_repeat,
      peer: $('s-peer') ? $('s-peer').checked : room.peer_voting
    };
  }

  // Every change saves by itself a moment later. There is no Save button.
  function autoSave() {
    settingsDirty = true;
    settingsVer++;
    clearTimeout(timers.settings);
    timers.settings = setTimeout(() => { savePending = pushSettings(false); }, 300);
  }

  async function pushSettings(silent) {
    const v = settingsVer;
    const s = readSettings();
    const r = await rpc('update_settings', {
      p_room_id: roomId,
      p_rounds: s.rounds,
      p_max: HIDDEN_MAX_PLAYERS,
      p_categories: s.cats,
      p_allow_repeat: s.repeat,
      p_letter_pool: FULL_ALPHABET,
      p_peer_voting: s.peer
    }, silent ? { silent: true } : undefined);
    savePending = null;
    if (settingsVer === v) settingsDirty = false;   // nothing newer is waiting
    settingsSig = '';                               // redraw the form from what the server really has
    await refresh();
    return !!r.ok;
  }

  // Used by Start game: make sure the latest change is saved before the game begins.
  async function flushSettings() {
    clearTimeout(timers.settings);
    if (!savePending) savePending = pushSettings(false);
    return savePending;
  }

  // ---------- game ----------
  function renderGame() {
    const rd = S.round, g = S.game;
    $('game-round').textContent = 'Round ' + rd.round_number + ' of ' + g.rounds_total;
    const L = $('game-letter');
    if (L.textContent !== rd.letter) {
      L.textContent = rd.letter;
      L.classList.remove('pop'); void L.offsetWidth; L.classList.add('pop');
    }
    if (builtRound !== rd.id) { buildForm(rd); builtRound = rd.id; }
    renderMembers($('game-members'), true);
    const playing = S.players.some((p) => p.user_id === me);
    $('spectator').hidden = playing;
    $('spectator').textContent = 'You were not in the room when this round started, so you are watching this one. You will play from the next round.';
    updateGameDynamic();
  }

  function buildForm(rd) {
    const box = $('answers');
    clear(box);
    for (const cat of orderCats(rd.category_ids)) {
      const input = el('input', {
        id: 'ans-' + cat, type: 'text', maxlength: '80', autocomplete: 'off', autocapitalize: 'words',
        spellcheck: 'false', enterkeyhint: 'next', 'data-cat': cat
      });
      input.value = (S.my_answers && S.my_answers[cat]) || '';
      input.addEventListener('input', () => onType(cat, input));
      input.addEventListener('blur', saveDraft);
      box.append(el('div', { class: 'field' },
        el('label', { for: 'ans-' + cat, text: catLabel(cat) }),
        input));
    }
  }

  function onType(cat, input) {
    input.classList.remove('invalid');
    debounce('draft', saveDraft, 400);
    updateGameDynamic();
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
    $('timer').textContent = fmt(Math.max(0, Math.floor((now - start) / 1000)));
    $('cap-note').textContent = 'The round ends when someone submits, or automatically at ' + fmt(Math.round((end - start) / 1000)) + '.';

    const locked = !mine || submitted || counting || over;
    document.querySelectorAll('#answers input').forEach((i) => { i.disabled = locked; });

    const vals = collect();
    const missing = orderCats(rd.category_ids).filter((c) => !(vals[c] || '').trim());
    $('submit-btn').disabled = locked || missing.length > 0;
    $('submit-hint').textContent = !mine ? 'You are watching this round.'
      : submitted ? 'Submitted. Waiting for the round to finish…'
      : counting ? 'Get ready. Typing starts in a moment.'
      : over ? 'The automatic round limit was reached. Answers are locked.'
      : missing.length ? 'Still needed: ' + missing.map(catLabel).join(', ')
      : 'Ready to submit. The first submission ends the round for everyone.';

    if (over && expiryCalledFor !== rd.id) { expiryCalledFor = rd.id; endIfExpired(rd.id); }
  }

  function tick() {
    if (!S) return;
    if (S.room.status === 'voting') updateVoteTimer();
    else updateGameDynamic();
  }

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
    const n = (answer || '').toLowerCase().replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return n.length > 0 && n[0].toUpperCase() === letter;
  }

  function renderResults() {
    const rd = S.round, g = S.game, room = S.room, isHost = room.host_id === me;
    if (room.status === 'voting' && S.voting) {
      $('res-body').hidden = true; $('winner-banner').hidden = true; $('vote-card').hidden = false;
      $('res-title').textContent = 'Round ' + rd.round_number + ' of ' + g.rounds_total + '. Letter ' + rd.letter;
      $('res-sub').textContent = endReasonText(rd) + ' Answers are locked. Time to vote.';
      renderVoting();
      return;
    }
    $('vote-card').hidden = true; $('res-body').hidden = false;
    $('res-title').textContent = 'Round ' + rd.round_number + ' of ' + g.rounds_total + ' results. Letter ' + rd.letter;
    $('res-sub').textContent = endReasonText(rd) + ' All answers are locked.';

    const catsBox = $('res-cats');
    clear(catsBox);
    if (S.results) {
      const players = S.players.map((p) => p.user_id).sort((a, b) => nick(a).localeCompare(nick(b)));
      for (const cat of orderCats(rd.category_ids)) {
        const ul = el('ul');
        for (const uid of players) {
          const a = S.results.find((x) => x.user_id === uid && x.category_id === cat) || { answer: '', points: 0 };
          const blank = !(a.answer || '').trim();
          let cls = 'bad', status = '✗ Not recognized (0)';
          if (blank) status = '✗ Blank (0)';
          else if (a.valid && a.duplicate) { cls = 'dup'; status = '= Shared answer +' + a.points; }
          else if (a.valid) { cls = 'ok'; status = (a.by_vote ? '✓ Accepted by vote +' : '✓ Correct +') + a.points; }
          else if (!clientLetterOk(a.answer, rd.letter)) status = '✗ Wrong letter (0)';
          ul.append(el('li', { class: 'res-row ' + cls },
            el('div', null, el('div', { class: 'who' }, avFor(uid), nick(uid) + (uid === me ? ' (you)' : '')),
              el('div', { class: 'ans', text: blank ? '(no answer)' : a.answer })),
            el('div', { class: 'status', text: status })));
        }
        catsBox.append(el('div', { class: 'card res-cat' }, el('h3', { text: catLabel(cat) }), ul));
      }
    }

    const rb = $('round-board'); clear(rb);
    [...S.players].sort((a, b) => (b.round_score || 0) - (a.round_score || 0)).forEach((p) => {
      rb.append(el('li', null, avFor(p.user_id), el('span', { class: 'grow', text: nick(p.user_id) + (p.user_id === me ? ' (you)' : '') }), el('span', { class: 'pts', text: (p.round_score || 0) + ' pts' })));
    });
    const tb = $('total-board'); clear(tb);
    S.totals.forEach((t) => {
      tb.append(el('li', null, avFor(t.user_id), el('span', { class: 'grow', text: nick(t.user_id) + (t.user_id === me ? ' (you)' : '') }), el('span', { class: 'pts', text: t.total + ' pts' })));
    });

    const finished = room.status === 'finished';
    const wb = $('winner-banner');
    wb.hidden = !finished;
    if (finished) {
      const names = (g.winner_ids || []).map(nick);
      clear(wb);
      wb.append(el('div', { class: 'wrow' }, (g.winner_ids || []).map((u) => avatarEl((S.avatars || {})[u], 64))),
        el('div', { text: '🏆 ' + (names.length > 1 ? 'Shared win: ' : 'Winner: ') + names.join(' & ') }));
    }

    $('next-btn').hidden = !(isHost && !finished);
    $('wait-host').hidden = isHost || finished;

    const rm = $('rematch');
    rm.hidden = !finished;
    if (finished) {
      const yes = S.rematch_votes.filter((v) => v.vote && S.members.some((m) => m.user_id === v.user_id)).length;
      const mine = S.rematch_votes.find((v) => v.user_id === me);
      $('rematch-text').textContent = yes + ' of ' + S.members.length + ' players want a rematch. It starts when more than half of the players vote yes and the host is still in the room.'
        + (mine ? ' You voted ' + (mine.vote ? 'yes.' : 'no.') : '');
      $('vote-yes').setAttribute('aria-pressed', String(!!(mine && mine.vote)));
      $('vote-no').setAttribute('aria-pressed', String(!!(mine && !mine.vote)));
    }
  }

  function endReasonText(rd) {
    if (rd.end_reason === 'submission') return nick(rd.ended_by) + ' submitted first.';
    if (rd.end_reason === 'timeout') return 'Nobody submitted, so the automatic ' + fmt(Math.round((Date.parse(rd.ends_at) - Date.parse(rd.starts_at)) / 1000)) + ' limit ended the round.';
    return 'The round was cancelled.';
  }

  function renderVoting() {
    const v = S.voting, ul = $('vote-list');
    clear(ul);
    const assigned = S.my_vote_items;              // answers given to me to check
    const items = assigned || v.items;
    for (const it of items) {
      const own = !assigned && it.mine;
      const who = assigned && it.author_ids ? it.author_ids.map(nick).join(' & ') : '';
      const controls = own
        ? el('span', { class: 'tag', text: 'Your answer' })
        : el('div', { class: 'vote-btns' },
            el('button', { class: 'btn small ' + (it.my_vote === true ? 'primary' : 'secondary'), type: 'button',
              'aria-pressed': String(it.my_vote === true), text: '✓ Accept', onclick: () => castVote(it, true) }),
            el('button', { class: 'btn small ' + (it.my_vote === false ? 'danger' : 'secondary'), type: 'button',
              'aria-pressed': String(it.my_vote === false), text: '✗ Reject', onclick: () => castVote(it, false) }));
      ul.append(el('li', { class: 'vote-item' },
        el('div', null,
          el('div', { class: 'vcat', text: catLabel(it.category_id) + (who ? ' (' + who + ')' : '') }),
          el('div', { class: 'vtext', text: it.text })),
        controls));
    }
    if (!items.length) ul.append(el('li', { class: 'muted', text: assigned ? 'You have nothing to check this round. Waiting for the others…' : 'Nothing to vote on.' }));
    $('vote-progress').textContent = v.cast + ' of ' + v.expected + ' answers checked. Checking ends early when everything has been checked.';
    updateVoteTimer();
  }

  function updateVoteTimer() {
    if (!S || !S.voting) return;
    const left = Math.ceil((Date.parse(S.voting.ends_at) - serverNow()) / 1000);
    $('vote-timer').textContent = left > 0 ? 'Voting closes in ' + fmt(left) : 'Counting the votes…';
    if (left <= 0 && voteExpiryCalledFor !== S.round.id) {
      const rid = S.round.id;
      voteExpiryCalledFor = rid;
      rpc('end_round_if_expired', { p_round_id: rid }, { silent: true }).then(refresh);
      setTimeout(() => { if (S && S.room.status === 'voting' && S.round.id === rid) voteExpiryCalledFor = null; }, 1500);
    }
  }

  async function castVote(it, v) {
    await rpc('cast_vote', { p_round_id: S.round.id, p_category_id: it.category_id, p_norm: it.norm, p_vote: v });
    await refresh();
  }

  $('next-btn').addEventListener('click', () => withBusy($('next-btn'), async () => {
    const r = await rpc('next_round', { p_room_id: roomId });
    if (r.ok) { builtRound = null; refresh(); }
  }));

  async function vote(v) {
    const r = await rpc('vote_rematch', { p_game_id: S.game.id, p_vote: v });
    if (r.ok && r.rematch_started) { builtRound = null; toast('Rematch starting!', 'ok'); }
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
