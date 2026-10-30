// Nucleo del Sudoku: geometria, risolutore, generatore. Condiviso tra browser (script classico,
// i nomi diventano globali) e server Node (module.exports).
// ---------- Geometria della griglia ----------
const ROW = i => Math.floor(i / 9);
const COL = i => i % 9;
const BOX = i => Math.floor(ROW(i) / 3) * 3 + Math.floor(COL(i) / 3);
const UNITS = [];
for (let r = 0; r < 9; r++) UNITS.push({ type: 'riga', cells: [...Array(9)].map((_, c) => r * 9 + c) });
for (let c = 0; c < 9; c++) UNITS.push({ type: 'colonna', cells: [...Array(9)].map((_, r) => r * 9 + c) });
for (let b = 0; b < 9; b++) {
  const r0 = Math.floor(b / 3) * 3, c0 = (b % 3) * 3, cells = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cells.push((r0 + r) * 9 + c0 + c);
  UNITS.push({ type: 'riquadro', cells });
}
const PEERS = [...Array(81)].map((_, i) => {
  const s = new Set();
  for (let j = 0; j < 81; j++)
    if (j !== i && (ROW(j) === ROW(i) || COL(j) === COL(i) || BOX(j) === BOX(i))) s.add(j);
  return [...s];
});
const ALL = 0x3FE; // bit 1..9
const bitCount = m => { let c = 0; while (m) { m &= m - 1; c++; } return c; };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- Risolutore (backtracking con bitmask) ----------
// Conta le soluzioni fino a "limit". Se fillRandom è true, restituisce una griglia completa casuale.
function solve(grid, limit = 2, fillRandom = false) {
  const g = grid.slice();
  const rows = new Uint16Array(9), cols = new Uint16Array(9), boxes = new Uint16Array(9);
  for (let i = 0; i < 81; i++) {
    const v = g[i]; if (!v) continue;
    const b = 1 << v;
    if ((rows[ROW(i)] | cols[COL(i)] | boxes[BOX(i)]) & b) return { count: 0 };
    rows[ROW(i)] |= b; cols[COL(i)] |= b; boxes[BOX(i)] |= b;
  }
  let count = 0, first = null;
  (function rec() {
    let best = -1, bestMask = 0, bestN = 10;
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      const m = ALL & ~(rows[ROW(i)] | cols[COL(i)] | boxes[BOX(i)]);
      const n = bitCount(m);
      if (n === 0) return;
      if (n < bestN) { best = i; bestMask = m; bestN = n; if (n === 1) break; }
    }
    if (best === -1) { count++; if (!first) first = g.slice(); return; }
    const digits = [];
    for (let v = 1; v <= 9; v++) if (bestMask & (1 << v)) digits.push(v);
    if (fillRandom) shuffle(digits);
    const r = ROW(best), c = COL(best), bx = BOX(best);
    for (const v of digits) {
      const b = 1 << v;
      g[best] = v; rows[r] |= b; cols[c] |= b; boxes[bx] |= b;
      rec();
      g[best] = 0; rows[r] &= ~b; cols[c] &= ~b; boxes[bx] &= ~b;
      if (count >= limit) return;
    }
  })();
  return { count, solution: first };
}

// ---------- Candidati e risolutore "umano" (per graduare la difficoltà) ----------
function candidates(grid) {
  const cand = new Uint16Array(81);
  for (let i = 0; i < 81; i++) {
    if (grid[i]) continue;
    let m = ALL;
    for (const p of PEERS[i]) if (grid[p]) m &= ~(1 << grid[p]);
    cand[i] = m;
  }
  return cand;
}

// Trova un passo logico: "singolo nudo" (una sola cifra possibile nella casella)
// oppure "singolo nascosto" (una cifra può andare in un solo posto di riga/colonna/riquadro).
function findSingle(grid, allowHidden) {
  const cand = candidates(grid);
  for (let i = 0; i < 81; i++) {
    if (!grid[i] && bitCount(cand[i]) === 1) {
      return { cell: i, value: Math.log2(cand[i]), kind: 'naked' };
    }
  }
  if (!allowHidden) return null;
  for (const unit of UNITS) {
    for (let v = 1; v <= 9; v++) {
      let spot = -1, n = 0;
      for (const i of unit.cells) {
        if (grid[i] === v) { n = -1; break; }
        if (!grid[i] && (cand[i] & (1 << v))) { spot = i; n++; }
      }
      if (n === 1) return { cell: spot, value: v, kind: 'hidden', unit: unit.type };
    }
  }
  return null;
}

function solvableBySingles(puzzle, allowHidden) {
  const g = puzzle.slice();
  for (;;) {
    const step = findSingle(g, allowHidden);
    if (!step) break;
    g[step.cell] = step.value;
  }
  return g.every(v => v);
}

// ---------- Generatore ----------
const LEVELS = {
  easy:   { name: 'Facile',    target: 38, hidden: false },
  medium: { name: 'Medio',     target: 30, hidden: true },
  hard:   { name: 'Difficile', target: 22, hidden: null },
};

function generate(level) {
  const cfg = LEVELS[level];
  let fallback = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const solution = solve(Array(81).fill(0), 1, true).solution;
    const puzzle = solution.slice();
    let givens = 81;
    // Rimozione simmetrica (i e 80-i), per un aspetto più "classico".
    const order = shuffle([...Array(41).keys()]);
    for (const i of order) {
      if (givens <= cfg.target) break;
      const j = 80 - i;
      const vi = puzzle[i], vj = puzzle[j];
      puzzle[i] = 0; puzzle[j] = 0;
      const removed = i === j ? 1 : 2;
      let ok = solve(puzzle, 2).count === 1;
      // Facile e Medio: il puzzle deve restare risolvibile con le sole tecniche di base.
      if (ok && cfg.hidden !== null) ok = solvableBySingles(puzzle, cfg.hidden);
      if (ok) givens -= removed;
      else { puzzle[i] = vi; puzzle[j] = vj; }
    }
    const result = { puzzle, solution };
    if (cfg.hidden !== null) return result;
    // Difficile: deve richiedere tecniche oltre i singoli.
    if (!solvableBySingles(puzzle, true)) return result;
    fallback = result;
  }
  return fallback;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ROW, COL, BOX, UNITS, PEERS, ALL, bitCount, solve, candidates, findSingle, solvableBySingles, generate, LEVELS };
}
