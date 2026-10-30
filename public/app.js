// ---------- Stato di gioco ----------
let S = null;          // stato corrente
let selected = -1;
let notesMode = false;
let history = [];
let timerId = null;
let checkMarks = new Set(); // caselle sbagliate mostrate da "Verifica" fino alla mossa successiva
let warnShown = false;

const $ = id => document.getElementById(id);
const boardEl = $('board');
const cells = [];

let newGameSeq = 0;
async function newGame(level) {
  if (S && !S.won && S.values.some((v, i) => v && !S.puzzle[i])) {
    if (!confirm('Iniziare una nuova partita? La partita in corso andrà persa.')) return;
  }
  if (S && S.played && !S.won && !S.abandoned) { S.abandoned = true; statsAbandon(S); }
  $('winOverlay').classList.remove('show');
  document.body.classList.add('loading');
  setMsg('Genero un nuovo sudoku…');
  const seq = ++newGameSeq;
  const remote = await requestRankedGame(level);   // null se offline o server non disponibile
  if (seq !== newGameSeq) return;                  // nel frattempo è partita un'altra richiesta
  let puzzle, solution;
  if (remote) {
    puzzle = remote.puzzle.split('').map(Number);
    solution = solve(puzzle, 1).solution;          // il server non invia la soluzione: la ricava il browser
  } else {
    await new Promise(r => setTimeout(r, 20));     // lascia disegnare il messaggio prima del calcolo
    ({ puzzle, solution } = generate(level));
  }
  S = {
    level, puzzle, solution,
    values: puzzle.slice(),
    notes: Array(81).fill(0),
    hinted: Array(81).fill(false),
    elapsed: 0, errors: 0, hints: 0, won: false,
    ranked: !!remote, gameId: remote ? remote.gameId : null,
    t0: Date.now(),                                // inizio partita: in classifica il tempo è quello reale
  };
  history = [];
  checkMarks.clear();
  selected = -1;
  document.body.classList.remove('loading');
  setMsg(!remote && ONLINE ? 'Server non raggiungibile: questa partita è fuori classifica.' : '');
  startTimer();
  render();
  save();
}

function snapshot() {
  checkMarks.clear();
  if (!S.played) { S.played = true; statsStart(S); }
  history.push({ values: S.values.slice(), notes: S.notes.slice(), hinted: S.hinted.slice() });
  if (history.length > 300) history.shift();
}

function undo() {
  const h = history.pop();
  if (!h || S.won) return;
  checkMarks.clear();
  S.values = h.values; S.notes = h.notes; S.hinted = h.hinted;
  render(); save();
}

function isLocked(i) { return S.puzzle[i] !== 0 || S.hinted[i]; }

function setValue(i, v) {
  if (i < 0 || isLocked(i) || S.won) return;
  snapshot();
  if (S.values[i] === v) { S.values[i] = 0; }
  else {
    S.values[i] = v;
    S.notes[i] = 0;
    // Rimuove automaticamente l'appunto dalle caselle collegate.
    for (const p of PEERS[i]) S.notes[p] &= ~(1 << v);
    if (v !== S.solution[i]) S.errors++;
  }
  afterMove();
}

function toggleNote(i, v) {
  if (i < 0 || S.values[i] || S.won) return;
  snapshot();
  S.notes[i] ^= (1 << v);
  afterMove();
}

function erase(i) {
  if (i < 0 || isLocked(i) || S.won) return;
  if (!S.values[i] && !S.notes[i]) return;
  snapshot();
  S.values[i] = 0; S.notes[i] = 0;
  afterMove();
}

function autoNotes() {
  if (S.won) return;
  snapshot();
  const cand = candidates(S.values);
  for (let i = 0; i < 81; i++) S.notes[i] = S.values[i] ? 0 : cand[i];
  setMsg('Appunti compilati con tutti i candidati possibili.');
  afterMove();
  showNotesInfo();
}

function showNotesInfo() {
  try { if (localStorage.getItem('sudoku-hideNotesInfo') === '1') return; } catch (e) {}
  const empty = S.values.filter(v => !v).length;
  $('notesInfoCount').textContent = `Appunti scritti in ${empty} caselle vuote.`;
  $('notesInfoHide').checked = false;
  $('notesOverlay').classList.add('show');
}
function closeNotesInfo() {
  if ($('notesInfoHide').checked) {
    try { localStorage.setItem('sudoku-hideNotesInfo', '1'); } catch (e) {}
  }
  $('notesOverlay').classList.remove('show');
}

function hint() {
  if (S.won) return;
  // 1) Se ci sono errori, prima li segnala.
  const wrong = [];
  for (let i = 0; i < 81; i++) if (S.values[i] && S.values[i] !== S.solution[i]) wrong.push(i);
  if (wrong.length) {
    const i = wrong.includes(selected) ? selected : wrong[0];
    selected = i;
    render();
    flash(i, true);
    setMsg(`C'è un errore in riga ${ROW(i) + 1}, colonna ${COL(i) + 1}: il ${S.values[i]} non è corretto. Correggilo prima di continuare.`);
    return;
  }
  // 2) Casella selezionata vuota → rivela quella. Altrimenti cerca il prossimo passo logico.
  let target, text;
  if (selected >= 0 && !S.values[selected]) {
    target = selected;
    text = explain(target, S.solution[target]);
  } else {
    const step = findSingle(S.values, true);
    if (step) {
      target = step.cell;
      text = explain(target, step.value);
    } else {
      const empty = [];
      for (let i = 0; i < 81; i++) if (!S.values[i]) empty.push(i);
      target = empty[Math.floor(Math.random() * empty.length)];
      text = `Qui va il ${S.solution[target]}. (Nessuna deduzione semplice disponibile in questo momento: servono tecniche avanzate.)`;
    }
  }
  if (S.ranked && S.hints === 0 && !confirm('Usando un suggerimento questa partita non entrerà in classifica. Continuare?')) return;
  snapshot();
  const v = S.solution[target];
  S.values[target] = v;
  S.notes[target] = 0;
  S.hinted[target] = true;
  for (const p of PEERS[target]) S.notes[p] &= ~(1 << v);
  S.hints++;
  selected = target;
  setMsg(text);
  afterMove();
  flash(target);
}

function explain(i, v) {
  const pos = `(riga ${ROW(i) + 1}, colonna ${COL(i) + 1})`;
  const cand = candidates(S.values);
  if (bitCount(cand[i]) === 1) return `Il ${v} è l'unico numero possibile in questa casella ${pos}: tutti gli altri sono già presenti in riga, colonna o riquadro.`;
  for (const unit of UNITS) {
    if (!unit.cells.includes(i)) continue;
    const spots = unit.cells.filter(j => !S.values[j] && (cand[j] & (1 << v)));
    if (spots.length === 1) return `In questa ${unit.type} il ${v} può andare solo qui ${pos}.`;
  }
  return `Qui va il ${v} ${pos}. Non è ancora deducibile con un passaggio semplice: prova a lavorare prima su altre caselle.`;
}

function afterMove() {
  if (S.values.every((v, i) => v === S.solution[i])) {
    S.won = true;
    stopTimer();
    if (S.ranked) { S.finalMs = Date.now() - S.t0; S.elapsed = Math.round(S.finalMs / 1000); }
    // In una partita in classifica il tempo preciso compare una sola volta, nella riga sotto.
    const timeText = S.ranked && S.hints === 0 ? '' : ` in ${fmt(S.elapsed)}`;
    $('winText').textContent = `Livello ${LEVELS[S.level].name} completato${timeText} con ${S.errors} errori e ${S.hints} suggerimenti.`;
    const record = statsWin(S);
    $('winRecord').textContent = !record ? ''
      : record.prev === null ? '🏆 Primo record per questo livello!'
      : `🏆 Nuovo record! (precedente: ${fmt(record.prev)})`;
    submitRanked();
    setTimeout(() => $('winOverlay').classList.add('show'), 300);
  } else {
    const warning = deadEndWarning();
    if (warning) setMsg(warning, true);
    else if (warnShown) setMsg('');
  }
  render(); save();
}

// Segnala quando la griglia non può più essere completata: c'è per forza un errore.
function deadEndWarning() {
  if (S.values.every(v => v)) return 'La griglia è piena ma contiene errori: premi “Verifica” per vedere dove.';
  const cand = candidates(S.values);
  for (let i = 0; i < 81; i++) {
    if (!S.values[i] && !cand[i]) {
      return `Nella casella in riga ${ROW(i) + 1}, colonna ${COL(i) + 1} non può più andare nessun numero: c'è almeno un errore. Premi “Verifica” per vederlo.`;
    }
  }
  return null;
}

function verify() {
  if (S.won) return;
  const wrong = [];
  for (let i = 0; i < 81; i++) if (S.values[i] && S.values[i] !== S.solution[i]) wrong.push(i);
  checkMarks = new Set(wrong);
  render();
  const n = wrong.length;
  setMsg(n === 0 ? 'Finora è tutto corretto! 👍'
    : n === 1 ? '1 casella sbagliata, evidenziata in rosso.'
    : `${n} caselle sbagliate, evidenziate in rosso.`);
}

// ---------- Rendering ----------
function buildBoard() {
  for (let i = 0; i < 81; i++) {
    const d = document.createElement('div');
    d.className = `cell r${ROW(i)} c${COL(i)}`;
    d.addEventListener('mousedown', () => { selected = i; render(); });
    boardEl.appendChild(d);
    cells.push(d);
  }
  const pad = $('pad');
  for (let v = 1; v <= 9; v++) {
    const b = document.createElement('button');
    b.innerHTML = `${v}<small></small>`;
    b.dataset.v = v;
    b.addEventListener('click', () => input(v, false));
    pad.appendChild(b);
  }
}

function render() {
  if (!S) return;
  const showErr = $('showErrors').checked;
  const selVal = selected >= 0 ? S.values[selected] : 0;
  const counts = Array(10).fill(0);
  for (const v of S.values) if (v) counts[v]++;

  for (let i = 0; i < 81; i++) {
    const el = cells[i], v = S.values[i];
    const cls = [`cell r${ROW(i)} c${COL(i)}`];
    if (S.puzzle[i]) cls.push('given');
    else if (S.hinted[i]) cls.push('hinted');
    else if (v) cls.push('user');
    if (selected >= 0) {
      if (i === selected) cls.push('selected');
      else if (selVal && v === selVal) cls.push('same');
      else if (PEERS[selected].includes(i)) cls.push('peer');
    }
    if (v && !S.puzzle[i]) {
      if (PEERS[i].some(p => S.values[p] === v)) cls.push('conflict');
      if ((showErr || checkMarks.has(i)) && v !== S.solution[i]) cls.push('wrong');
    }
    el.className = cls.join(' ');
    if (v) el.textContent = v;
    else if (S.notes[i]) {
      let h = '<div class="notes">';
      for (let n = 1; n <= 9; n++) {
        const on = S.notes[i] & (1 << n);
        h += `<span class="${on && n === selVal ? 'hl' : ''}">${on ? n : ''}</span>`;
      }
      el.innerHTML = h + '</div>';
    } else el.textContent = '';
  }

  document.querySelectorAll('#pad button').forEach(b => {
    const v = +b.dataset.v, left = 9 - counts[v];
    b.querySelector('small').textContent = left > 0 ? left : '';
    b.classList.toggle('done', left <= 0);
  });
  document.querySelectorAll('.side [data-level]').forEach(b => b.classList.toggle('active', b.dataset.level === S.level));
  $('notesBtn').textContent = `✎ Appunti: ${notesMode ? 'ON' : 'OFF'}`;
  $('notesBtn').classList.toggle('active', notesMode);
  $('undoBtn').disabled = !history.length;
  $('levelLabel').textContent = LEVELS[S.level].name;
  $('rankBadge').textContent = S.ranked ? (S.hints > 0 ? '· fuori classifica' : '· 🏆 in classifica') : '';
  $('errCount').textContent = S.errors;
  $('hintCount').textContent = S.hints;
  $('timer').textContent = fmt(S.elapsed);
}

function flash(i, isError) {
  const el = cells[i];
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  if (isError) el.classList.add('wrong');
}

function setMsg(t, isWarning = false) { $('msg').textContent = t; warnShown = isWarning; }

// ---------- Timer ----------
function fmt(s) {
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
// Le partite in classifica durano finché il server tiene aperta la partita (24 ore).
const RANKED_MAX_MS = 23.5 * 3600 * 1000;

function tick() {
  if (!S || S.won) return;
  if (S.ranked) {
    // Il server misura il tempo reale dall'inizio, quindi anche il cronometro non si ferma mai:
    // così il tempo che vedi è quello che finisce in classifica.
    if (Date.now() - S.t0 > RANKED_MAX_MS) {
      S.ranked = false;
      setMsg('Sono passate più di 24 ore: la partita non è più in classifica.');
      render();
    }
    S.elapsed = Math.max(0, Math.floor((Date.now() - S.t0) / 1000));
  } else {
    if (document.hidden || document.querySelector('.overlay.show')) return;
    S.elapsed++;
  }
  $('timer').textContent = fmt(S.elapsed);
  if (S.elapsed % 5 === 0) save();
}
function startTimer() {
  stopTimer();
  timerId = setInterval(tick, 1000);
}
function stopTimer() { if (timerId) clearInterval(timerId); timerId = null; }

// ---------- Salvataggio locale ----------
function save() {
  try { localStorage.setItem('sudoku-state', JSON.stringify(S)); } catch (e) {}
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem('sudoku-state'));
    if (d && d.puzzle && d.puzzle.length === 81) return d;
  } catch (e) {}
  return null;
}

// ---------- Statistiche ----------
// Salvate in localStorage sotto la chiave "sudoku-stats", separate dalla partita in corso.
const STATS_KEY = 'sudoku-stats';
const MAX_RECENT = 50;
const emptyLevel = () => ({
  played: 0, completed: 0, abandoned: 0,
  noErrors: 0, perfect: 0,
  best: null, totalTime: 0,
  streak: 0, bestStreak: 0,
});
const emptyStats = () => ({
  version: 1,
  levels: { easy: emptyLevel(), medium: emptyLevel(), hard: emptyLevel() },
  recent: [],
});

function normalizeStats(d) {
  if (!d || typeof d !== 'object' || !d.levels || typeof d.levels !== 'object') return null;
  const s = emptyStats();
  for (const lv in s.levels) Object.assign(s.levels[lv], d.levels[lv] || {});
  s.recent = Array.isArray(d.recent) ? d.recent.slice(0, MAX_RECENT) : [];
  return s;
}
function loadStats() {
  try { return normalizeStats(JSON.parse(localStorage.getItem(STATS_KEY))) || emptyStats(); }
  catch (e) { return emptyStats(); }
}
function saveStats() {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(STATS)); } catch (e) {}
}
let STATS = loadStats();

function addRecent(game, result) {
  STATS.recent.unshift({
    date: Date.now(), level: game.level, result,
    time: game.elapsed, errors: game.errors, hints: game.hints,
  });
  STATS.recent.length = Math.min(STATS.recent.length, MAX_RECENT);
}

// Una partita conta come "giocata" alla prima mossa.
function statsStart(game) {
  STATS.levels[game.level].played++;
  saveStats();
}

function statsAbandon(game) {
  const lv = STATS.levels[game.level];
  lv.abandoned++;
  lv.streak = 0;
  addRecent(game, 'abandoned');
  saveStats();
}

function statsWin(game) {
  const lv = STATS.levels[game.level];
  lv.completed++;
  lv.totalTime += game.elapsed;
  if (game.errors === 0) lv.noErrors++;
  if (game.errors === 0 && game.hints === 0) lv.perfect++;
  lv.streak = game.errors === 0 ? lv.streak + 1 : 0;
  lv.bestStreak = Math.max(lv.bestStreak, lv.streak);
  // Il record vale solo per le partite risolte senza suggerimenti.
  let record = null;
  if (game.hints === 0 && (lv.best === null || game.elapsed < lv.best)) {
    record = { prev: lv.best };
    lv.best = game.elapsed;
  }
  addRecent(game, 'won');
  saveStats();
  return record;
}

function renderStats() {
  const keys = Object.keys(LEVELS);
  const L = keys.map(k => STATS.levels[k]);
  const sum = f => L.reduce((a, l) => a + l[f], 0);
  const tot = {
    played: sum('played'), completed: sum('completed'), abandoned: sum('abandoned'),
    noErrors: sum('noErrors'), perfect: sum('perfect'), totalTime: sum('totalTime'),
  };
  const bests = L.map(l => l.best).filter(b => b !== null);
  tot.best = bests.length ? Math.min(...bests) : null;
  const pct = (a, b) => b ? ` <span class="lost">(${Math.round(a / b * 100)}%)</span>` : '';
  const time = s => s === null || s === undefined ? '–' : fmt(s);
  const avg = l => l.completed ? fmt(Math.round(l.totalTime / l.completed)) : '–';

  const rows = [
    ['Partite giocate', l => l.played],
    ['Completate', l => l.completed + pct(l.completed, l.played)],
    ['Abbandonate', l => l.abandoned],
    ['Completate senza errori', l => l.noErrors + pct(l.noErrors, l.completed)],
    ['Perfette (né errori né suggerimenti)', l => l.perfect + pct(l.perfect, l.completed)],
    ['Tempo record (senza suggerimenti)', l => time(l.best)],
    ['Tempo medio', avg],
    ['Serie attuale senza errori', l => l.streak ?? '–'],
    ['Serie migliore senza errori', l => l.bestStreak ?? '–'],
    ['Tempo totale di gioco', l => fmt(l.totalTime)],
  ];
  let h = '<div class="tablewrap"><table><thead><tr><th></th>';
  for (const k of keys) h += `<th>${LEVELS[k].name}</th>`;
  h += '<th>Totale</th></tr></thead><tbody>';
  for (const [label, f] of rows) {
    h += `<tr><td>${label}</td>`;
    for (const l of L) h += `<td class="num">${f(l)}</td>`;
    h += `<td class="num">${f(tot)}</td></tr>`;
  }
  h += '</tbody></table></div>';

  h += '<h4>Ultime partite</h4>';
  if (!STATS.recent.length) h += '<p class="empty">Nessuna partita ancora registrata.</p>';
  else {
    h += '<div class="tablewrap"><table><thead><tr><th>Data</th><th>Livello</th><th>Esito</th><th>Tempo</th><th>Errori</th><th>Sugg.</th></tr></thead><tbody>';
    for (const g of STATS.recent.slice(0, 15)) {
      const d = new Date(g.date);
      const date = d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' })
        + ' ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      const res = g.result === 'won'
        ? `<span class="won">${g.errors === 0 && g.hints === 0 ? 'Perfetta' : 'Completata'}</span>`
        : '<span class="lost">Abbandonata</span>';
      h += `<tr><td>${date}</td><td>${LEVELS[g.level]?.name ?? '?'}</td><td>${res}</td>
        <td class="num">${fmt(g.time)}</td><td class="num">${g.errors}</td><td class="num">${g.hints}</td></tr>`;
    }
    h += '</tbody></table></div>';
  }
  $('statsBody').innerHTML = h;
}

function openStats() { renderStats(); $('statsOverlay').classList.add('show'); }
function closeStats() { $('statsOverlay').classList.remove('show'); }

function exportStats() {
  const blob = new Blob([JSON.stringify(STATS, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sudoku-statistiche-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importStats(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data = null;
    try { data = normalizeStats(JSON.parse(reader.result)); } catch (e) {}
    if (!data) { alert('Il file non contiene statistiche valide.'); return; }
    if (!confirm('Sostituire le statistiche attuali con quelle del file?')) return;
    STATS = data;
    saveStats();
    renderStats();
  };
  reader.readAsText(file);
}

function resetStats() {
  if (!confirm('Azzerare tutte le statistiche? Questa operazione non si può annullare (a meno di avere un backup).')) return;
  STATS = emptyStats();
  saveStats();
  renderStats();
}

// ---------- Tutorial ----------
// Gli esempi sono situazioni reali, estratte da sudoku con soluzione unica.
// Le deduzioni mostrate (numeri esclusi, candidati cancellati) sono ricalcolate dal codice.
const TUT_GRIDS = {
  naked:  '105047239703060015000013000004100000009485100000006300000670000810050907537920601',
  hidden: '000002000460009800030000049098005430600070008073400520310000060004600092000900000',
  pair:   '075304100042185007080706000400239700000478000007651002000507090700943500004802370',
  point:  '070800950609105800500094600900500176356000248010000593002350700000008405065007380',
  triple: '000018603276500841813006500040680010600100000130025060381962754065301289920850136',
  xwing:  '457000200010000478020074030000019040195743682000580000030920850280000000509060321',
  assurdo: '913004200004270091872100045391426050008030100020081930240017083130000400086342019',
};
const toGrid = str => str.split('').map(Number);
const where = i => `riga ${ROW(i) + 1}, colonna ${COL(i) + 1}`;
const digitsOf = m => { const a = []; for (let v = 1; v <= 9; v++) if (m & (1 << v)) a.push(v); return a; };
const valuesIn = (g, cells) => [...new Set(cells.map(j => g[j]).filter(Boolean))].sort((a, b) => a - b);
const rowCells = r => UNITS[r].cells;
const colCells = c => UNITS[9 + c].cells;
const boxCells = b => UNITS[18 + b].cells;
const joinD = a => a.length ? a.join(', ') : 'nessuno';

function lessonRules() {
  const g = toGrid(TUT_GRIDS.naked), i = 45;
  return {
    title: 'Le regole', level: 'Base', grid: g,
    steps: [
      { text: 'Il Sudoku è una griglia di 9×9 caselle divisa in 9 riquadri da 3×3 (quelli con il bordo più spesso). Lo scopo è riempirla con i numeri da 1 a 9.' },
      { text: `<b>Regola 1:</b> in ogni <b>riga</b> i numeri da 1 a 9 compaiono una volta sola. Qui è evidenziata la riga ${ROW(i) + 1}: ha già dei numeri, che quindi non possono ripetersi nelle sue caselle vuote.`, units: [rowCells(ROW(i))] },
      { text: `<b>Regola 2:</b> lo stesso vale per ogni <b>colonna</b>. Qui è evidenziata la colonna ${COL(i) + 1}.`, units: [colCells(COL(i))] },
      { text: `<b>Regola 3:</b> lo stesso vale per ogni <b>riquadro</b> 3×3. Qui è evidenziato quello che contiene la casella in ${where(i)}.`, units: [boxCells(BOX(i))] },
      { text: 'Un sudoku ben fatto ha <b>una sola soluzione</b>: si arriva sempre alla fine con la logica, senza mai tirare a indovinare. Le prossime lezioni mostrano le tecniche per farlo.' },
    ],
  };
}

function lessonNaked() {
  const g = toGrid(TUT_GRIDS.naked), i = 45;
  const parts = [['Nella riga', rowCells(ROW(i))], ['Nella colonna', colCells(COL(i))], ['Nel riquadro', boxCells(BOX(i))]];
  let struck = 0;
  const steps = [{
    text: `Guarda la casella evidenziata (${where(i)}). Quale numero può contenere? All'inizio potrebbe essere qualsiasi numero da 1 a 9: togliamo quelli impossibili.`,
    target: [i], custom: { cell: i, normal: ALL, struck: 0 },
  }];
  for (const [label, cells] of parts) {
    const vals = valuesIn(g, cells);
    const added = digitsOf(vals.reduce((m, v) => m | (1 << v), 0) & ~struck);
    for (const v of vals) struck |= 1 << v;
    steps.push({
      text: `${label} ci sono già: <b>${joinD(vals)}</b>. ${added.length ? `Cancelliamo ${joinD(added)} dai candidati della casella.` : 'Nessun nuovo numero da cancellare.'}`,
      units: [cells], target: [i], custom: { cell: i, normal: ALL & ~struck, struck },
    });
  }
  const left = digitsOf(ALL & ~struck);
  steps.push({
    text: `È rimasto un solo candidato: il <b>${left[0]}</b>. Non può andare altro in questa casella, quindi lo scriviamo. Si chiama <b>singolo nudo</b>: una casella con un unico numero possibile.`,
    target: [i], place: { cell: i, d: left[0] },
  });
  return { title: 'Singolo nudo', level: 'Base', grid: g, steps, check: { cell: i, d: left[0], count: left.length } };
}

function lessonHidden() {
  const g = toGrid(TUT_GRIDS.hidden), b = 3, v = 4, sp = 37;
  const cells = boxCells(b);
  const blocked = cells.filter(j => !g[j] && j !== sp);
  return {
    title: 'Singolo nascosto', level: 'Base', grid: g,
    steps: [
      { text: `Questa volta guardiamo un intero riquadro (quello evidenziato) e ci chiediamo: <b>dove può andare il ${v}?</b>`, units: [cells] },
      { text: `I ${v} già presenti nella griglia sono evidenziati. Un ${v} in una riga o in una colonna vieta il ${v} a tutta quella riga e colonna: le caselle del riquadro contrassegnate con ✕ non possono quindi contenere il ${v}.`, units: [cells], match: v, blocked },
      { text: `Nel riquadro resta una sola casella libera per il ${v}: quella in ${where(sp)}. Il ${v} deve stare in questo riquadro e non ha altro posto, quindi va <b>lì</b>.`, units: [cells], match: v, blocked, place: { cell: sp, d: v } },
      { text: `Si chiama <b>singolo nascosto</b>: la casella potrebbe contenere anche altri numeri (per questo è "nascosto"), ma per il ${v} è l'unica possibilità nel riquadro. Lo stesso ragionamento funziona anche con una riga o una colonna intera.` },
    ],
    check: { cell: sp, d: v },
  };
}

function lessonPair() {
  const g = toGrid(TUT_GRIDS.pair), r = 8, A = 76, B = 80;
  const cand = candidates(g), row = rowCells(r);
  const empt = row.filter(j => !g[j]);
  const pair = digitsOf(cand[A]);
  const elim = [];
  for (const j of empt) if (j !== A && j !== B) for (const d of pair) if (cand[j] & (1 << d)) elim.push([j, d]);
  const rest = empt.filter(j => j !== A && j !== B).map(j => {
    const left = digitsOf(cand[j]).filter(d => !pair.includes(d));
    return `${where(j)}: ${joinD(left)}`;
  });
  return {
    title: 'Coppia nuda', level: 'Avanzato', grid: g, noteCells: empt,
    steps: [
      { text: `Qui i numeri semplici non bastano più, quindi usiamo gli appunti. Nella riga ${r + 1} le caselle vuote mostrano i numeri ancora possibili (i candidati).`, units: [row] },
      { text: `Guarda le due caselle evidenziate (${where(A)} e ${where(B)}): hanno <b>solo</b> gli stessi due candidati, <b>${pair[0]}</b> e <b>${pair[1]}</b>. È una <b>coppia nuda</b>.`, units: [row], target: [A, B], hl: pair },
      { text: `Una delle due caselle conterrà il ${pair[0]} e l'altra il ${pair[1]} (non sappiamo ancora quale). In ogni caso questi due numeri sono "presi" da queste due caselle: nessun'altra casella della riga può contenerli.`, units: [row], target: [A, B], hl: pair },
      { text: `Possiamo quindi cancellare ${pair[0]} e ${pair[1]} dagli appunti delle altre caselle della riga (barrati in rosso).`, units: [row], target: [A, B], elim },
      { text: `Risultato: meno candidati, quindi deduzioni più facili. Nelle altre caselle della riga restano: ${rest.join(' · ')}.`, units: [row], target: [A, B], elim, hideElim: true },
    ],
    check: { pair, A, B, elim },
  };
}

function lessonPoint() {
  const g = toGrid(TUT_GRIDS.point), b = 7, v = 4;
  const cand = candidates(g), cells = boxCells(b);
  const sp = cells.filter(j => !g[j] && (cand[j] & (1 << v)));
  const r = ROW(sp[0]), line = rowCells(r);
  const elim = line.filter(j => !g[j] && BOX(j) !== b && (cand[j] & (1 << v))).map(j => [j, v]);
  const noteCells = [...new Set([...cells, ...line])].filter(j => !g[j]);
  return {
    title: 'Puntamento', level: 'Avanzato', grid: g, noteCells, noteDigit: v,
    steps: [
      { text: `In questo esempio guardiamo solo i candidati del <b>${v}</b> (gli altri appunti sono nascosti per chiarezza). Partiamo dal riquadro evidenziato.`, units: [cells] },
      { text: `Nel riquadro il ${v} può andare <b>solo</b> in queste ${sp.length} caselle (${sp.map(where).join(' oppure ')}).`, units: [cells], target: sp },
      { text: `Sono tutte sulla <b>stessa riga</b> (la riga ${r + 1}). Quindi il ${v} di questo riquadro, in qualunque di queste caselle vada, starà in questa riga.`, units: [line], target: sp },
      { text: `Ma in una riga il ${v} può esserci una volta sola: nelle caselle della riga <b>fuori dal riquadro</b> il ${v} non può andare. Cancelliamo il ${v} da ${elim.map(e => where(e[0])).join(' e ')}.`, units: [line], target: sp, elim },
      { text: `Fatto: un candidato in meno. Funziona anche con 3 caselle allineate e con le colonne. Si chiama <b>puntamento</b>, perché i candidati del riquadro "puntano" lungo la riga o la colonna.`, units: [line], target: sp, elim, hideElim: true },
    ],
    check: { elim, v, sp },
  };
}

function lessonTriple() {
  const g = toGrid(TUT_GRIDS.triple), u = 0, cells3 = [0, 1, 2];
  const cand = candidates(g), unit = UNITS[u];
  const empt = unit.cells.filter(j => !g[j]);
  const tri = digitsOf(cand[0] | cand[1] | cand[2]);
  const elim = [];
  for (const j of empt) if (!cells3.includes(j)) for (const d of tri) if (cand[j] & (1 << d)) elim.push([j, d]);
  const rest = empt.filter(j => !cells3.includes(j)).map(j => {
    const left = digitsOf(cand[j]).filter(d => !tri.includes(d));
    return `${where(j)}: ${joinD(left)}`;
  });
  const T = joinD(tri);
  return {
    title: 'Terna nuda', level: 'Avanzato', grid: g, noteCells: empt,
    steps: [
      { text: `È la coppia nuda estesa a tre caselle. Nella riga ${u + 1} le caselle vuote mostrano i numeri ancora possibili (i candidati).`, units: [unit.cells] },
      { text: `Guarda le tre caselle evidenziate (${cells3.map(where).join('; ')}): insieme usano <b>solo</b> i numeri <b>${T}</b>. Non serve che ogni casella li abbia tutti e tre. È una <b>terna nuda</b>.`, units: [unit.cells], target: cells3, hl: tri },
      { text: `Tre caselle e tre numeri: ognuna prenderà uno di questi numeri e alla fine li useranno tutti e tre. Quindi nessun'altra casella della riga può contenere ${T}.`, units: [unit.cells], target: cells3, hl: tri },
      { text: `Cancelliamo dunque ${joinD(elim.map(e => e[1]))} dalle altre caselle della riga (barrati in rosso): ${elim.map(e => `il ${e[1]} in ${where(e[0])}`).join(' e ')}.`, units: [unit.cells], target: cells3, elim },
      { text: `Risultato: nelle altre caselle della riga restano ${rest.join(' · ')}. Meno candidati, quindi deduzioni più facili.`, units: [unit.cells], target: cells3, elim, hideElim: true },
    ],
    check: { cells: cells3, tri, elim },
  };
}

function lessonXWing() {
  const g = toGrid(TUT_GRIDS.xwing), v = 3, r1 = 0, r2 = 7, k1 = 3, k2 = 4;
  const cand = candidates(g);
  const rowsV = [r1, r2];
  const corners = [r1 * 9 + k1, r1 * 9 + k2, r2 * 9 + k1, r2 * 9 + k2];
  const elim = [];
  for (const k of [k1, k2]) for (const j of colCells(k))
    if (!g[j] && (cand[j] & (1 << v)) && ROW(j) !== r1 && ROW(j) !== r2) elim.push([j, v]);
  const spots = r => rowCells(r).filter(j => !g[j] && (cand[j] & (1 << v)));
  const noteCells = [...new Set([...rowCells(r1), ...rowCells(r2), ...colCells(k1), ...colCells(k2)])].filter(j => !g[j]);
  const diagA = [corners[0], corners[3]], diagB = [corners[1], corners[2]];
  const lines = [rowCells(r1), rowCells(r2)];
  return {
    title: 'X-Wing', level: 'Esperto', grid: g, noteCells, noteDigit: v,
    steps: [
      { text: `L'X-Wing ragiona su <b>un solo numero</b> alla volta: qui il <b>${v}</b> (gli altri appunti sono nascosti). Nella riga ${r1 + 1} il ${v} può andare in sole <b>due</b> caselle.`, units: [lines[0]], target: spots(r1) },
      { text: `Anche nella riga ${r2 + 1} il ${v} ha solo due posti possibili, e sono nelle <b>stesse due colonne</b> (la ${k1 + 1} e la ${k2 + 1}). Le quattro caselle formano un rettangolo.`, units: lines, target: corners },
      { text: `In ogni riga il ${v} va in una sola delle due caselle. Possibilità 1: il ${v} sta in ${where(diagA[0])} e in ${where(diagA[1])} (una diagonale del rettangolo).`, units: lines, target: diagA },
      { text: `Possibilità 2: il ${v} sta nell'altra diagonale, in ${where(diagB[0])} e in ${where(diagB[1])}. Non ce ne sono altre, ma non sappiamo ancora quale sia quella giusta.`, units: lines, target: diagB },
      { text: `In <b>entrambi</b> i casi, le colonne ${k1 + 1} e ${k2 + 1} avranno il loro ${v} nelle righe ${r1 + 1} e ${r2 + 1}. Quindi in tutte le altre caselle di quelle due colonne il ${v} non può andare: cancelliamolo da ${elim.map(e => where(e[0])).join(' e ')}.`, units: [colCells(k1), colCells(k2)], target: corners, elim },
      { text: `Fatto: ${elim.length} candidati in meno. Funziona anche scambiando righe e colonne. Si chiama X-Wing perché le due diagonali del rettangolo formano una X.`, units: [colCells(k1), colCells(k2)], target: corners, elim, hideElim: true },
    ],
    check: { v, rowsV, corners, elim },
  };
}

function lessonSkyscraper() {
  const g = toGrid(TUT_GRIDS.assurdo), v = 6, rA = 2, rB = 6, kBase = 6;
  const cand = candidates(g);
  const spots = r => rowCells(r).filter(j => !g[j] && (cand[j] & (1 << v)));
  const sA = spots(rA), sB = spots(rB);
  const baseA = sA.find(j => COL(j) === kBase), baseB = sB.find(j => COL(j) === kBase);
  const roofA = sA.find(j => j !== baseA), roofB = sB.find(j => j !== baseB);
  const sees = (a, b) => a !== b && PEERS[a].includes(b);
  const elim = [];
  for (let j = 0; j < 81; j++)
    if (!g[j] && j !== roofA && j !== roofB && sees(j, roofA) && sees(j, roofB) && (cand[j] & (1 << v))) elim.push([j, v]);
  const left = elim.map(([j]) => `${where(j)}: ${joinD(digitsOf(cand[j]).filter(d => d !== v))}`);
  const noteCells = [];
  for (let j = 0; j < 81; j++) if (!g[j]) noteCells.push(j);
  const rows = [rowCells(rA), rowCells(rB)], all4 = [baseA, roofA, baseB, roofB];
  return {
    title: 'Skyscraper', level: 'Esperto', grid: g, noteCells, noteDigit: v,
    steps: [
      { text: `Come per l'X-Wing, lavoriamo su un solo numero: il <b>${v}</b> (gli altri appunti sono nascosti). Nella riga ${rA + 1} il ${v} può andare in sole <b>due</b> caselle: ${sA.map(where).join(' oppure ')}.`, units: [rows[0]], target: sA },
      { text: `Anche nella riga ${rB + 1} il ${v} ha solo due posti: ${sB.map(where).join(' oppure ')}.`, units: [rows[1]], target: sB },
      { text: `Le due righe hanno un posto nella <b>stessa colonna</b>, la ${kBase + 1} (le "basi", evidenziate come colonna). Gli altri due posti, ${where(roofA)} e ${where(roofB)}, sono i "tetti". A differenza dell'X-Wing i tetti sono in colonne diverse.`, units: [colCells(kBase)], target: all4 },
      { text: `Ci sono due casi. Se il ${v} della riga ${rA + 1} sta nella base (colonna ${kBase + 1}), allora la base della riga ${rB + 1} (stessa colonna) non può averlo, e il ${v} della riga ${rB + 1} sta nel suo tetto. Se invece il ${v} della riga ${rA + 1} sta nel suo tetto, abbiamo già un tetto col ${v}. <b>In ogni caso almeno uno dei due tetti ha il ${v}.</b>`, units: [colCells(kBase)], target: [roofA, roofB] },
      { text: `Quindi le caselle che vedono <b>entrambi</b> i tetti non possono contenere il ${v}: ${elim.map(([j]) => where(j)).join(' e ')}. Le abbiamo evidenziate con il ${v} barrato.`, target: [roofA, roofB], elim },
      { text: `Risultato: ${left.join(' · ')}. Nei sudoku difficili uno Skyscraper come questo sblocca altre deduzioni (nell'esempio della prossima lezione ne vedremo una).`, target: [roofA, roofB], elim, hideElim: true },
    ],
    check: { v, elim, roofs: [roofA, roofB], bases: [baseA, baseB] },
  };
}

// Candidati già eliminati nelle lezioni precedenti (coppie nude e puntamenti) e dallo Skyscraper dell'esempio.
const TUT_ASSURDO_REMOVED = [[3, 6], [14, 5], [15, 6], [43, 7], [44, 7], [45, 5], [45, 7], [53, 7], [67, 6]];

function lessonAssurdo() {
  const g = toGrid(TUT_GRIDS.assurdo);
  const X = 48, Y = 47, P = 3, Q = 14, R = 23, Z = 41; // r6c4, r6c3, r1c4, r2c6, r3c6, r5c6
  const cand = candidates(g);
  TUT_ASSURDO_REMOVED.forEach(([j, d]) => { cand[j] &= ~(1 << d); });
  const dd = j => digitsOf(cand[j]);
  const [a, b] = dd(X);              // 5 e 7
  const e1 = [[P, a], [Z, a]];        // il 5 sparisce da colonna 4 e riquadro 5
  const e2 = [...e1, [Q, 8]];
  const e3 = [...e2, [R, 3]];
  const e4 = [...e3, [Z, 9]];
  const hyp = [{ cell: X, d: a }];
  return {
    title: 'Ipotesi per assurdo', level: 'Esperto', grid: g, noteCells: [X, Y, P, Q, R, Z], removed: TUT_ASSURDO_REMOVED,
    steps: [
      { text: `Quando le tecniche dirette finiscono si può ragionare <b>per assurdo</b>: si fa un'ipotesi e si guarda se porta a una contraddizione. Se sì, l'ipotesi è falsa e vale l'altra. Partiamo dagli appunti già ripuliti (coppie nude e Skyscraper sul 6). Nella ${where(X)} i candidati sono <b>${a}</b> e <b>${b}</b>: cosa succede se fosse ${a}?`, target: [X], hl: [a] },
      { text: `<b>Ipotesi: ${where(X)} = ${a}.</b> Cancelliamo il ${a} dalle caselle che la vedono: ${where(P)} (stessa colonna) ${dd(P).includes(a) ? `resta con ${joinD(dd(P).filter(d => d !== a))}` : ''} e ${where(Z)} (stesso riquadro) resta con ${joinD(dd(Z).filter(d => d !== a))}.`, target: [X], place: hyp, hyp: true, elim: e1 },
      { text: `In ${where(P)} resta il solo candidato <b>8</b>. Quell'8 sta nel riquadro in alto al centro, quindi si cancella da ${where(Q)}, che resta con il solo <b>3</b>.`, target: [P], place: [...hyp, { cell: P, d: 8 }], hyp: true, elim: e2 },
      { text: `Il 3 in ${where(Q)} sta nella colonna 6: si cancella dalla ${where(R)}, che resta con il solo <b>9</b>.`, target: [Q], place: [...hyp, { cell: P, d: 8 }, { cell: Q, d: 3 }], hyp: true, elim: e3 },
      { text: `Ora guarda la ${where(Z)}: il ${a} era già cancellato (stesso riquadro di ${where(X)}) e il 9 si cancella ora perché è nella colonna 6 insieme a ${where(R)}. <b>Non resta nessun numero possibile</b>: contraddizione!`, target: [Z], place: [...hyp, { cell: P, d: 8 }, { cell: Q, d: 3 }, { cell: R, d: 9 }], hyp: true, elim: e4 },
      { text: `L'ipotesi porta a un'impossibilità, quindi è falsa: la ${where(X)} non può essere ${a}. Resta il <b>${b}</b>, e di conseguenza la ${where(Y)} è <b>${a}</b>. Da qui il sudoku prosegue con i soli singoli.`, target: [X, Y], place: [{ cell: X, d: b }, { cell: Y, d: a }] },
      { text: `Non è "tirare a indovinare": non si scrive mai un numero perché sembra giusto, ma solo dopo aver dimostrato che l'alternativa è impossibile. Conviene provare su caselle con <b>due soli candidati</b> e catene corte, e usare questa tecnica solo quando le altre non bastano.` },
    ],
    check: { X, Y, a, b },
  };
}

function lessonTips() {
  return {
    title: 'Consigli', level: '', grid: null,
    steps: [
      { text: '<b>Parti dai numeri più frequenti.</b> Se il 5 compare già 7 volte nella griglia, è facile trovare dove vanno gli ultimi due.' },
      { text: '<b>Cerca prima i singoli.</b> Guarda le caselle con un solo numero possibile (singolo nudo) e i numeri con un solo posto in un riquadro, riga o colonna (singolo nascosto).' },
      { text: '<b>Dopo ogni numero inserito, riguarda le vicinanze.</b> Un numero nuovo toglie candidati a tutta la sua riga, colonna e riquadro e spesso sblocca altre caselle.' },
      { text: '<b>Quando sei bloccato, usa gli appunti.</b> Premi ✎ Compila appunti, poi cerca coppie e terne nude, puntamenti e, nei casi più duri, X-Wing e Skyscraper per ridurre i candidati. Come ultima risorsa, ragiona per assurdo.' },
      { text: '<b>Non tirare a indovinare.</b> Ogni sudoku ha una sola soluzione e si risolve con la logica. Se hai un dubbio, ✔ Verifica ti mostra gli errori e 💡 Suggerisci ti spiega il prossimo passo.' },
    ],
  };
}

let tut = null; // { lessons, li, si, cells }

function buildLessons() {
  return [lessonRules(), lessonNaked(), lessonHidden(), lessonPair(), lessonPoint(), lessonTriple(), lessonXWing(), lessonSkyscraper(), lessonAssurdo(), lessonTips()];
}

function renderTutorial() {
  const lesson = tut.lessons[tut.li];
  const step = lesson.steps[tut.si];
  const last = tut.si === lesson.steps.length - 1;
  const isLastLesson = tut.li === tut.lessons.length - 1;

  $('tutChips').innerHTML = tut.lessons.map((l, k) =>
    `<button data-k="${k}" class="${k === tut.li ? 'active' : ''}">${k + 1}. ${l.title}${l.level ? ` · ${l.level}` : ''}</button>`).join('');

  const board = $('tutBoard');
  board.style.display = lesson.grid ? '' : 'none';
  if (lesson.grid) {
    const g = lesson.grid, cand = candidates(g);
    (lesson.removed || []).forEach(([j, d]) => { cand[j] &= ~(1 << d); });
    const placeMap = new Map((Array.isArray(step.place) ? step.place : step.place ? [step.place] : []).map(q => [q.cell, q.d]));
    const inList = (list, i) => !!list && list.includes(i);
    const unitSet = new Set((step.units || []).flat());
    const elimSet = new Set((step.elim || []).map(e => e[0] * 10 + e[1]));
    // kind: null = cifra assente, '' = normale, 'k' = evidenziata, 's' = barrata
    const notesHtml = kindOf => {
      let h = '<div class="tnotes">';
      for (let n = 1; n <= 9; n++) {
        const k = kindOf(n);
        h += `<span class="${k || ''}">${k === null ? '' : n}</span>`;
      }
      return h + '</div>';
    };
    for (let i = 0; i < 81; i++) {
      const el = tut.cells[i], cls = [`tc r${ROW(i)} c${COL(i)}`];
      if (unitSet.has(i)) cls.push('u');
      if (inList(step.target, i)) cls.push('t');
      if (step.match && g[i] === step.match) cls.push('m');
      if (inList(step.blocked, i)) cls.push('x');
      let html = '';
      if (placeMap.has(i)) { html = placeMap.get(i); cls.push(step.hyp ? 'hyp' : 'placed'); }
      else if (g[i]) html = g[i];
      else if (step.custom && step.custom.cell === i) {
        const c = step.custom;
        html = notesHtml(n => (c.struck & (1 << n)) ? 's' : (c.normal & (1 << n)) ? '' : null);
      } else if (lesson.noteCells && lesson.noteCells.includes(i)) {
        html = notesHtml(n => {
          if (!(cand[i] & (1 << n))) return null;
          if (lesson.noteDigit && n !== lesson.noteDigit) return null;
          if (elimSet.has(i * 10 + n)) return step.hideElim ? null : 's';
          if (inList(step.target, i) && ((step.hl && step.hl.includes(n)) || lesson.noteDigit)) return 'k';
          return '';
        });
      }
      el.className = cls.join(' ');
      el.innerHTML = html;
    }
  }
  $('tutText').innerHTML = step.text;
  $('tutCount').textContent = `Passo ${tut.si + 1} di ${lesson.steps.length}`;
  $('tutPrev').disabled = tut.si === 0 && tut.li === 0;
  $('tutNext').textContent = !last ? 'Avanti ›' : isLastLesson ? 'Fine ✓' : 'Prossima lezione ›';
}

function tutGo(delta) {
  const lesson = tut.lessons[tut.li];
  const n = tut.si + delta;
  if (n >= 0 && n < lesson.steps.length) tut.si = n;
  else if (n < 0 && tut.li > 0) { tut.li--; tut.si = tut.lessons[tut.li].steps.length - 1; }
  else if (n >= lesson.steps.length) {
    if (tut.li === tut.lessons.length - 1) { closeTutorial(); return; }
    tut.li++; tut.si = 0;
  }
  renderTutorial();
}

function openTutorial(li = 0) {
  if (!tut) {
    tut = { lessons: buildLessons(), li: 0, si: 0, cells: [] };
    const board = $('tutBoard');
    for (let i = 0; i < 81; i++) { const d = document.createElement('div'); board.appendChild(d); tut.cells.push(d); }
  }
  tut.li = li; tut.si = 0;
  renderTutorial();
  $('tutOverlay').classList.add('show');
}
function closeTutorial() { $('tutOverlay').classList.remove('show'); }

// ---------- Input ----------
function input(v, forceNote) {
  if (selected < 0) { setMsg('Seleziona prima una casella.'); return; }
  if (notesMode || forceNote) toggleNote(selected, v);
  else setValue(selected, v);
}

document.addEventListener('keydown', e => {
  if (handleOnlineKeys(e)) return;
  if ($('tutOverlay').classList.contains('show')) {
    if (e.key === 'Escape') closeTutorial();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') tutGo(1);
    else if (e.key === 'ArrowLeft') tutGo(-1);
    return;
  }
  if ($('notesOverlay').classList.contains('show')) {
    if (e.key === 'Escape' || e.key === 'Enter') closeNotesInfo();
    return;
  }
  if ($('statsOverlay').classList.contains('show')) {
    if (e.key === 'Escape') closeStats();
    return;
  }
  if (!S) return;
  const m = e.code.match(/^(Digit|Numpad)([1-9])$/);
  if (m) { e.preventDefault(); input(+m[2], e.shiftKey); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k === 'Backspace' || k === 'Delete' || k === '0') { e.preventDefault(); erase(selected); }
  else if (k === 'n' || k === 'N') { notesMode = !notesMode; render(); }
  else if (k === 'h' || k === 'H') hint();
  else if (k === 'v' || k === 'V') verify();
  else if (k.startsWith('Arrow')) {
    e.preventDefault();
    if (selected < 0) selected = 40;
    else {
      let r = ROW(selected), c = COL(selected);
      if (k === 'ArrowUp') r = (r + 8) % 9;
      if (k === 'ArrowDown') r = (r + 1) % 9;
      if (k === 'ArrowLeft') c = (c + 8) % 9;
      if (k === 'ArrowRight') c = (c + 1) % 9;
      selected = r * 9 + c;
    }
    render();
  }
});

document.querySelectorAll('[data-level]').forEach(b => b.addEventListener('click', () => newGame(b.dataset.level)));
$('notesBtn').addEventListener('click', () => { notesMode = !notesMode; render(); });
$('eraseBtn').addEventListener('click', () => erase(selected));
$('undoBtn').addEventListener('click', undo);
$('hintBtn').addEventListener('click', hint);
$('autoNotesBtn').addEventListener('click', autoNotes);
$('checkBtn').addEventListener('click', verify);
$('tutBtn').addEventListener('click', () => openTutorial(0));
$('tutClose').addEventListener('click', closeTutorial);
$('tutPrev').addEventListener('click', () => tutGo(-1));
$('tutNext').addEventListener('click', () => tutGo(1));
$('tutChips').addEventListener('click', e => {
  const b = e.target.closest('button[data-k]');
  if (b) { tut.li = +b.dataset.k; tut.si = 0; renderTutorial(); }
});
$('tutOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeTutorial(); });
$('notesInfoClose').addEventListener('click', closeNotesInfo);
$('notesOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeNotesInfo(); });
document.querySelectorAll('.statsBtn').forEach(b => b.addEventListener('click', openStats));
$('statsClose').addEventListener('click', closeStats);
$('statsOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeStats(); });
$('exportBtn').addEventListener('click', exportStats);
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', e => {
  if (e.target.files[0]) importStats(e.target.files[0]);
  e.target.value = '';
});
$('resetBtn').addEventListener('click', resetStats);
$('showErrors').addEventListener('change', () => {
  try { localStorage.setItem('sudoku-showErrors', $('showErrors').checked ? '1' : '0'); } catch (e) {}
  render();
});

// ---------- Avvio ----------
buildBoard();
try { $('showErrors').checked = localStorage.getItem('sudoku-showErrors') === '1'; } catch (e) {}
(async () => {
  await initOnline();
  const saved = load();
  if (saved && !saved.won) {
    S = saved;
    if (S.ranked && !S.t0) S.t0 = Date.now() - S.elapsed * 1000;
    startTimer();
    tick();
    render();
    const warning = deadEndWarning();
    setMsg(warning || 'Partita precedente ripristinata.', !!warning);
  } else {
    newGame('easy');
  }
})();
