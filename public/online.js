// ---------- Online: profilo, classifica e partite in classifica ----------
// Funziona solo se il gioco è servito dal server (http/https). Aperto da file, o se il server non
// risponde, tutto il resto del gioco continua a funzionare e le funzioni online sono nascoste.
// Questo file viene caricato prima di app.js: usa $, S, LEVELS ecc. solo dentro le funzioni.

const ACC_KEY = 'sudoku-account';
let ACC = null;        // { token, name } dell'utente collegato
let ONLINE = false;    // il server risponde
let authMode = 'login';
let authThen = null;   // azione da ripetere dopo l'accesso (es. registrare il tempo di una partita)
const lbState = { level: 'easy', period: 'all' };
const PERIOD_NAMES = { all: 'Sempre', week: 'Settimana', month: 'Mese' };

// Tempo con un decimale: 83400 -> "1:23.4"
function fmtMs(ms) {
  const t = Math.round(ms / 100) / 10;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
}

// Crea un elemento DOM con testo sicuro (mai innerHTML con dati degli utenti).
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

// ---------- Chiamate al server ----------
// Non lancia mai eccezioni: restituisce { ok, status, data } (status 0 = server non raggiungibile).
async function api(method, path, body, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (ACC) headers.Authorization = 'Bearer ' + ACC.token;
    const res = await fetch(path, {
      method, headers, signal: ctrl.signal, cache: 'no-store',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* risposta non JSON */ }
    // Token scaduto o revocato: si torna "non collegati".
    if (res.status === 401 && ACC && data && data.error === 'auth_required') {
      ACC = null; saveAccount(); updateAccountUI();
    }
    return { ok: res.ok, status: res.status, data: data || {} };
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'network' } };
  } finally {
    clearTimeout(timer);
  }
}

function loadAccount() {
  try {
    const d = JSON.parse(localStorage.getItem(ACC_KEY));
    if (d && typeof d.token === 'string' && typeof d.name === 'string') ACC = d;
  } catch (e) { /* storage non disponibile */ }
}
function saveAccount() {
  try {
    if (ACC) localStorage.setItem(ACC_KEY, JSON.stringify(ACC));
    else localStorage.removeItem(ACC_KEY);
  } catch (e) { /* storage non disponibile */ }
}

function updateAccountUI() {
  $('accBtn').textContent = ACC ? `👤 ${ACC.name}` : '👤 Accedi';
}

// ---------- Partita in classifica ----------
// Chiede al server un sudoku (il tempo parte da qui). Restituisce null se offline o non disponibile:
// in quel caso il gioco genera il sudoku in locale e la partita resta fuori classifica.
async function requestRankedGame(level) {
  if (!ONLINE) return null;
  const r = await api('POST', 'api/games', { level }, 6000);
  if (r.ok && typeof r.data.puzzle === 'string' && r.data.puzzle.length === 81) return r.data;
  return null;
}

// Mostra nella finestra di vittoria l'esito della registrazione del tempo.
async function submitRanked() {
  const box = $('winRank'), actions = $('winRankActions');
  box.textContent = '';
  actions.replaceChildren();
  const game = S;
  if (!game || !game.ranked) return;
  const say = (text, ...buttons) => {
    if (S !== game) return;               // nel frattempo è iniziata un'altra partita
    box.textContent = text;
    actions.replaceChildren(...buttons);
  };
  if (game.hints > 0) return say('Con i suggerimenti la partita non entra in classifica.');
  if (!ACC) {
    return say('Crea un profilo o accedi per registrare questo tempo in classifica.',
      el('button', { class: 'active', text: 'Accedi / Crea profilo' }));
  }
  say('Registro il tuo tempo…');
  const r = await api('POST', `api/games/${encodeURIComponent(game.gameId)}/finish`, { solution: game.solution.join(''), hints: game.hints });
  if (r.ok && r.data.ranked) {
    const k = r.data.ranks;
    return say(`🏆 Tempo in classifica: ${fmtMs(r.data.timeMs)} (${k.all}° assoluto · ${k.week}° della settimana · ${k.month}° del mese). ${r.data.personalBest ? 'Nuovo tuo record personale!' : 'Il tuo miglior tempo resta quello precedente.'}`);
  }
  if (r.ok) {
    return say(r.data.reason === 'too_fast'
      ? 'Tempo troppo breve per essere valido: non entra in classifica.'
      : 'Con i suggerimenti la partita non entra in classifica.');
  }
  if (r.status === 401) {
    return say('Accedi per registrare questo tempo in classifica.', el('button', { class: 'active', text: 'Accedi / Crea profilo' }));
  }
  if (r.status === 404) return say('Partita scaduta (oltre 24 ore): il tempo non è stato registrato.');
  if (r.status === 409) return say('Questo risultato è già stato registrato.');
  if (r.status === 0) return say('Server non raggiungibile: il tempo non è stato registrato.', el('button', { text: 'Riprova' }));
  return say(r.data.message || 'Non è stato possibile registrare il tempo.');
}

// I pulsanti creati da submitRanked non hanno listener propri: li gestisce questo handler.
function onWinRankClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.textContent === 'Riprova') submitRanked();
  else openAuth('register', submitRanked);
}

// ---------- Accesso e registrazione ----------
function setAuthMode(mode) {
  authMode = mode;
  const reg = mode === 'register';
  $('authOverlay').classList.toggle('reg', reg);
  $('authTitle').textContent = reg ? 'Crea il tuo profilo' : 'Accedi';
  $('authSubmit').textContent = reg ? 'Crea profilo' : 'Accedi';
  $('authPin').autocomplete = reg ? 'new-password' : 'current-password';
  document.querySelectorAll('#authTabs button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('authError').textContent = '';
}

function openAuth(mode = 'login', then = null) {
  authThen = then;
  setAuthMode(mode);
  $('authPin').value = '';
  $('authOverlay').classList.add('show');
  setTimeout(() => $(mode === 'register' ? 'authName' : 'authEmail').focus(), 50);
}
function closeAuth() {
  $('authOverlay').classList.remove('show');
  $('authPin').value = '';
  authThen = null;
}

async function submitAuth(e) {
  e.preventDefault();
  const email = $('authEmail').value.trim(), pin = $('authPin').value, name = $('authName').value.trim();
  const fail = text => { $('authError').textContent = text; };
  const reg = authMode === 'register';
  if (!email) return fail("Inserisci l'email.");
  if (!/^\d{6}$/.test(pin)) return fail('Il PIN deve essere di 6 cifre.');
  if (reg && name.length < 3) return fail('Il nome deve avere almeno 3 caratteri.');
  if (reg && !$('authPrivacy').checked) return fail("Conferma di aver letto l'informativa privacy.");

  $('authSubmit').disabled = true;
  $('authError').textContent = '';
  const r = await api('POST', reg ? 'api/register' : 'api/login', reg ? { email, pin, name } : { email, pin });
  $('authSubmit').disabled = false;
  if (!r.ok) return fail(r.status === 0 ? 'Server non raggiungibile, riprova.' : (r.data.message || 'Operazione non riuscita.'));

  ACC = { token: r.data.token, name: r.data.name };
  saveAccount();
  updateAccountUI();
  const then = authThen;
  // Svuota i campi: su un computer condiviso non devono restare email e nome dell'ultimo utente.
  $('authName').value = '';
  $('authEmail').value = '';
  $('authPrivacy').checked = false;
  closeAuth();
  if (then) then();
}

// ---------- Profilo ----------
async function openProfile() {
  if (!ACC) return openAuth('login');
  $('profileName').textContent = ACC.name;
  $('profileBests').replaceChildren(el('p', { class: 'empty', text: 'Carico…' }));
  $('delBox').hidden = true;
  $('delPin').value = '';
  $('delError').textContent = '';
  $('profileOverlay').classList.add('show');
  const r = await api('GET', 'api/me');
  if (!r.ok) return;
  ACC.name = r.data.name;
  saveAccount();
  updateAccountUI();
  $('profileName').textContent = ACC.name;
  const rows = Object.keys(LEVELS).map(level => {
    const b = r.data.bests[level];
    return el('tr', {}, el('td', { text: LEVELS[level].name }),
      el('td', { class: 'num', text: b ? fmtMs(b.timeMs) : '–' }),
      el('td', { class: 'num', text: b ? `${b.rank}°` : '–' }));
  });
  $('profileBests').replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, el('th', { text: 'Il tuo meglio' }), el('th', { text: 'Tempo' }), el('th', { text: 'Posizione' }))),
    el('tbody', {}, ...rows)));
}
function closeProfile() { $('profileOverlay').classList.remove('show'); }

async function logout() {
  await api('POST', 'api/logout');
  ACC = null;
  saveAccount();
  updateAccountUI();
  closeProfile();
}

async function deleteAccount() {
  const pin = $('delPin').value;
  if (!/^\d{6}$/.test(pin)) { $('delError').textContent = 'Inserisci il PIN di 6 cifre.'; return; }
  const r = await api('DELETE', 'api/me', { pin });
  if (!r.ok) { $('delError').textContent = r.status === 0 ? 'Server non raggiungibile.' : (r.data.message || 'Operazione non riuscita.'); return; }
  ACC = null;
  saveAccount();
  updateAccountUI();
  closeProfile();
  setMsg('Profilo eliminato: nome, PIN e tempi sono stati cancellati dal server.');
}

// ---------- Classifica ----------
function renderLbControls() {
  $('lbLevels').replaceChildren(...Object.keys(LEVELS).map(level =>
    el('button', { 'data-level-lb': level, class: level === lbState.level ? 'active' : '', text: LEVELS[level].name })));
  $('lbPeriods').replaceChildren(...Object.keys(PERIOD_NAMES).map(period =>
    el('button', { 'data-period': period, class: period === lbState.period ? 'active' : '', text: PERIOD_NAMES[period] })));
}

async function loadLeaderboard() {
  const { level, period } = lbState;
  const body = $('lbBody');
  body.replaceChildren(el('p', { class: 'empty', text: 'Carico…' }));
  const r = await api('GET', `api/leaderboard?level=${level}&period=${period}&limit=50`);
  if (level !== lbState.level || period !== lbState.period) return;   // l'utente ha cambiato scheda
  if (!r.ok) {
    body.replaceChildren(el('p', { class: 'empty', text: r.status === 0 ? 'Server non raggiungibile.' : (r.data.message || 'Errore nel caricamento.') }));
    return;
  }
  const { entries, me, total } = r.data;
  if (!entries.length) {
    body.replaceChildren(el('p', { class: 'empty', text: 'Nessun tempo ancora: sii il primo!' }));
    return;
  }
  const medal = n => ['🥇', '🥈', '🥉'][n - 1] || `${n}°`;
  const mine = ACC && ACC.name.toLowerCase();
  const rows = entries.map(e => el('tr', { class: mine && e.name.toLowerCase() === mine ? 'me' : '' },
    el('td', { class: 'num', text: medal(e.rank) }), el('td', { text: e.name }), el('td', { class: 'num', text: fmtMs(e.timeMs) })));
  const parts = [el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, el('th', { text: '#' }), el('th', { text: 'Giocatore' }), el('th', { text: 'Tempo' }))),
    el('tbody', {}, ...rows)))];
  if (me && me.rank > entries.length) parts.push(el('p', { class: 'note', text: `La tua posizione: ${me.rank}° su ${total} (${fmtMs(me.timeMs)}).` }));
  else if (!ACC) parts.push(el('p', { class: 'note', text: 'Accedi per vedere la tua posizione.' }));
  body.replaceChildren(...parts);
}

function openLeaderboard() {
  renderLbControls();
  $('lbOverlay').classList.add('show');
  loadLeaderboard();
}
function closeLeaderboard() { $('lbOverlay').classList.remove('show'); }

// Gestisce Esc quando è aperta una delle finestre online. Restituisce true se l'evento è "consumato".
function handleOnlineKeys(e) {
  const closers = { authOverlay: closeAuth, profileOverlay: closeProfile, lbOverlay: closeLeaderboard };
  const open = Object.keys(closers).find(id => $(id).classList.contains('show'));
  if (!open) return false;
  if (e.key === 'Escape') closers[open]();
  return true;
}

// ---------- Avvio ----------
async function initOnline() {
  loadAccount();
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    ONLINE = (await api('GET', 'api/health', undefined, 2500)).ok;
  }
  document.body.classList.toggle('offline', !ONLINE);
  if (ONLINE && ACC) {
    const r = await api('GET', 'api/me');
    if (r.ok) { ACC.name = r.data.name; saveAccount(); }
  }
  updateAccountUI();

  $('accBtn').addEventListener('click', () => (ACC ? openProfile() : openAuth('login')));
  document.querySelectorAll('.lbBtn').forEach(b => b.addEventListener('click', openLeaderboard));
  $('lbClose').addEventListener('click', closeLeaderboard);
  $('lbOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeLeaderboard(); });
  $('lbLevels').addEventListener('click', e => {
    const b = e.target.closest('button[data-level-lb]');
    if (b) { lbState.level = b.dataset.levelLb; renderLbControls(); loadLeaderboard(); }
  });
  $('lbPeriods').addEventListener('click', e => {
    const b = e.target.closest('button[data-period]');
    if (b) { lbState.period = b.dataset.period; renderLbControls(); loadLeaderboard(); }
  });
  $('authForm').addEventListener('submit', submitAuth);
  $('authTabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b) setAuthMode(b.dataset.mode);
  });
  $('authClose').addEventListener('click', closeAuth);
  $('authOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeAuth(); });
  $('profileClose').addEventListener('click', closeProfile);
  $('profileOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeProfile(); });
  $('logoutBtn').addEventListener('click', logout);
  $('delBtn').addEventListener('click', () => { $('delBox').hidden = false; $('delPin').focus(); });
  $('delConfirm').addEventListener('click', deleteAccount);
  $('winRankActions').addEventListener('click', onWinRankClick);
}
