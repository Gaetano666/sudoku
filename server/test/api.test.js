'use strict';
// Richiede un Redis raggiungibile (TEST_REDIS_URL, default redis://127.0.0.1:63790).
// Ogni test usa un prefisso di chiavi casuale, che viene ripulito alla fine.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Redis = require('ioredis');
const core = require('../../public/sudoku-core.js');
const { loadConfig } = require('../src/config');
const { buildApp, isoWeekKey } = require('../src/app');

const URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:63790';
const opened = [];

async function makeApp({ minMs } = {}) {
  const prefix = `t${Math.random().toString(36).slice(2, 10)}:`;
  const redis = new Redis(URL, { keyPrefix: prefix });
  const config = { ...loadConfig({}), minMs: minMs || { easy: 0, medium: 0, hard: 0 } };
  const clock = { t: 1_760_000_000_000 };
  const app = buildApp({ redis, config, now: () => clock.t });
  opened.push({ app, redis, prefix });
  return { app, redis, clock };
}

const ip = n => ({ 'x-real-ip': `10.0.0.${n}` });
const auth = token => ({ authorization: `Bearer ${token}` });
const json = res => JSON.parse(res.body);

let nextIp = 100;
async function register(app, over = {}, n = nextIp++) {
  const res = await app.inject({
    method: 'POST', url: '/api/register', headers: ip(n),
    payload: { email: 'mario@example.com', pin: '123456', name: 'Mario', ...over },
  });
  return { res, body: json(res) };
}

after(async () => {
  for (const { app, redis, prefix } of opened) {
    await app.close();
    const keys = await redis.keys('*');           // keyPrefix: solo le chiavi di questo test
    if (keys.length) await redis.del(...keys.map(k => k.slice(prefix.length)));
    redis.disconnect();
  }
});

test('registrazione, accesso e /api/me', async () => {
  const { app } = await makeApp();
  const { res, body } = await register(app);
  assert.equal(res.statusCode, 200);
  assert.equal(body.name, 'Mario');
  assert.ok(body.token.length > 30);

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: auth(body.token) });
  assert.equal(me.statusCode, 200);
  assert.equal(json(me).name, 'Mario');

  // L'email non va mai restituita né salvata in chiaro.
  assert.ok(!res.body.includes('example.com'));

  const login = await app.inject({ method: 'POST', url: '/api/login', headers: ip(1), payload: { email: ' MARIO@Example.com ', pin: '123456' } });
  assert.equal(login.statusCode, 200);
  assert.notEqual(json(login).token, body.token);

  assert.equal((await app.inject({ method: 'GET', url: '/api/me' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: auth('x'.repeat(43)) })).statusCode, 401);
});

test('nome ed email devono essere unici, con validazione degli input', async () => {
  const { app, redis } = await makeApp();
  await register(app);
  assert.equal(json((await register(app, { email: 'altro@example.com', name: 'mario' })).res).error, 'name_taken');
  assert.equal(json((await register(app, { email: 'MARIO@example.com', name: 'Luigi' })).res).error, 'email_taken');
  // Dopo il rifiuto per email, il nome "Luigi" non deve restare riservato.
  assert.equal(await redis.get('name:luigi'), null);
  assert.equal((await register(app, { email: 'luigi@example.com', name: 'Luigi' })).res.statusCode, 200);

  assert.equal(json((await register(app, { email: 'nonemail' })).res).error, 'bad_email');
  assert.equal(json((await register(app, { pin: '12345' })).res).error, 'bad_pin');
  assert.equal(json((await register(app, { pin: 'abcdef' })).res).error, 'bad_pin');
  for (const name of ['ab', 'x'.repeat(17), 'M@rio', '<b>ciao</b>', 'Mario!!']) {
    assert.equal(json((await register(app, { email: 'z@example.com', name })).res).error, 'bad_name', name);
  }
  const extra = await app.inject({ method: 'POST', url: '/api/register', headers: ip(1), payload: { email: 'a@b.it', pin: '123456', name: 'Nome', admin: true } });
  assert.equal(extra.statusCode, 200);                      // i campi sconosciuti vengono scartati
  assert.equal(json(extra).admin, undefined);
});

test('PIN errato: blocco temporaneo dopo 5 tentativi, anche col PIN giusto', async () => {
  const { app } = await makeApp();
  await register(app);
  const login = (pin, n = 2) => app.inject({ method: 'POST', url: '/api/login', headers: ip(n), payload: { email: 'mario@example.com', pin } });
  for (let i = 0; i < 5; i++) assert.equal((await login('000000')).statusCode, 401);
  const locked = await login('123456');
  assert.equal(locked.statusCode, 429);
  assert.equal(json(locked).error, 'locked');
  // Email inesistente: stessa risposta di un PIN sbagliato (niente enumerazione).
  const ghost = await app.inject({ method: 'POST', url: '/api/login', headers: ip(3), payload: { email: 'nessuno@example.com', pin: '123456' } });
  assert.equal(ghost.statusCode, 401);
  assert.equal(json(ghost).message, 'Email o PIN errati');
});

test('limite di registrazioni per IP', async () => {
  const { app } = await makeApp();
  for (let i = 0; i < 5; i++) await register(app, { email: `u${i}@example.com`, name: `Utente ${i}` }, 7);
  assert.equal((await register(app, { email: 'u9@example.com', name: 'Utente 9' }, 7)).res.statusCode, 429);
  assert.equal((await register(app, { email: 'u9@example.com', name: 'Utente 9' }, 8)).res.statusCode, 200);
});

async function play(app, token, { hints = 0, wrong = false, n = 1 } = {}) {
  const created = await app.inject({ method: 'POST', url: '/api/games', headers: ip(n), payload: { level: 'easy' } });
  assert.equal(created.statusCode, 200);
  const game = json(created);
  assert.equal(game.puzzle.length, 81);
  const puzzle = game.puzzle.split('').map(Number);
  assert.equal(core.solve(puzzle, 2).count, 1);
  const solution = core.solve(puzzle, 1).solution.join('');
  const finish = (sol, h = hints) => app.inject({
    method: 'POST', url: `/api/games/${game.gameId}/finish`, headers: { ...ip(n), ...(token ? auth(token) : {}) },
    payload: { solution: sol, hints: h },
  });
  return { game, solution, finish };
}

test('partita: il server non rivela la soluzione e valida il risultato', async () => {
  const { app, clock } = await makeApp();
  const { body: { token } } = await register(app);
  const { game, solution, finish } = await play(app, token);
  assert.equal(game.solution, undefined);

  const wrong = solution.slice(0, 80) + (solution[80] === '1' ? '2' : '1');
  assert.equal((await finish(wrong)).statusCode, 422);

  clock.t += 123_456;
  const ok = await finish(solution);
  assert.equal(ok.statusCode, 200);
  const r = json(ok);
  assert.equal(r.ranked, true);
  assert.equal(r.timeMs, 123_456);          // tempo misurato dal server
  assert.equal(r.personalBest, true);
  assert.deepEqual(r.ranks, { all: 1, week: 1, month: 1 });

  assert.equal((await finish(solution)).statusCode, 409);   // una sola chiusura
});

test('senza accesso non si entra in classifica, ma la partita resta valida', async () => {
  const { app } = await makeApp();
  const { solution, finish } = await play(app, null);
  const anon = await finish(solution);
  assert.equal(anon.statusCode, 401);
  assert.equal(json(anon).error, 'auth_required');
});

test('suggerimenti e tempi impossibili non entrano in classifica', async () => {
  const { app, clock } = await makeApp({ minMs: { easy: 45_000, medium: 60_000, hard: 90_000 } });
  const { body: { token } } = await register(app);

  let p = await play(app, token);
  clock.t += 200_000;
  let r = json(await p.finish(p.solution, 2));
  assert.deepEqual([r.ranked, r.reason], [false, 'hints']);

  p = await play(app, token);
  clock.t += 5_000;
  r = json(await p.finish(p.solution));
  assert.deepEqual([r.ranked, r.reason], [false, 'too_fast']);

  const lb = json(await app.inject({ method: 'GET', url: '/api/leaderboard?level=easy' }));
  assert.equal(lb.total, 0);
});

test('classifica: solo il miglior tempo, ordinata, con la mia posizione', async () => {
  const { app, clock } = await makeApp();
  const users = [];
  for (const [i, name] of ['Anna', 'Berto', 'Carla'].entries()) {
    users.push((await register(app, { email: `${name}@example.com`, name }, 10 + i)).body.token);
  }
  const times = [90_000, 60_000, 75_000];
  for (const [i, token] of users.entries()) {
    const p = await play(app, token, { n: 20 + i });
    clock.t += times[i];
    assert.equal(json(await p.finish(p.solution)).ranked, true);
  }
  // Anna migliora (50 s) e poi peggiora (200 s): conta il migliore.
  let p = await play(app, users[0], { n: 30 });
  clock.t += 50_000;
  assert.equal(json(await p.finish(p.solution)).personalBest, true);
  p = await play(app, users[0], { n: 31 });
  clock.t += 200_000;
  const worse = json(await p.finish(p.solution));
  assert.equal(worse.personalBest, false);
  assert.equal(worse.ranks.all, 1);

  const lb = json(await app.inject({ method: 'GET', url: '/api/leaderboard?level=easy&period=all', headers: { ...ip(40), ...auth(users[2]) } }));
  assert.deepEqual(lb.entries.map(e => [e.rank, e.name, e.timeMs]), [[1, 'Anna', 50_000], [2, 'Berto', 60_000], [3, 'Carla', 75_000]]);
  assert.deepEqual(lb.me, { rank: 3, timeMs: 75_000 });
  assert.equal(lb.total, 3);
  assert.ok(!JSON.stringify(lb).includes('@'));          // nessuna email in classifica

  assert.equal(json(await app.inject({ method: 'GET', url: '/api/leaderboard?level=hard' })).entries.length, 0);
  assert.equal((await app.inject({ method: 'GET', url: '/api/leaderboard?level=nope' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/leaderboard?period=year' })).statusCode, 400);
});

test('classifica settimanale: cambia con la settimana', async () => {
  const { app, clock } = await makeApp();
  const { body: { token } } = await register(app);
  let p = await play(app, token, { n: 50 });
  clock.t += 60_000;
  await p.finish(p.solution);
  const week = () => app.inject({ method: 'GET', url: '/api/leaderboard?level=easy&period=week' }).then(json);
  assert.equal((await week()).total, 1);
  clock.t += 8 * 86400_000;                                // la settimana dopo
  assert.equal((await week()).total, 0);
  assert.equal(json(await app.inject({ method: 'GET', url: '/api/leaderboard?level=easy&period=all' })).total, 1);
});

test('eliminazione del profilo: sparisce da tutto e il nome torna libero', async () => {
  const { app, redis, clock } = await makeApp();
  const { body: { token } } = await register(app);
  const p = await play(app, token);
  clock.t += 70_000;
  await p.finish(p.solution);

  const noPin = await app.inject({ method: 'DELETE', url: '/api/me', headers: { ...ip(1), ...auth(token) }, payload: { pin: '000000' } });
  assert.equal(noPin.statusCode, 401);
  const del = await app.inject({ method: 'DELETE', url: '/api/me', headers: { ...ip(1), ...auth(token) }, payload: { pin: '123456' } });
  assert.equal(del.statusCode, 200);

  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: auth(token) })).statusCode, 401);
  for (const period of ['all', 'week', 'month']) {
    assert.equal(json(await app.inject({ method: 'GET', url: `/api/leaderboard?level=easy&period=${period}` })).total, 0, period);
  }
  assert.equal((await register(app, {}, 2)).res.statusCode, 200);   // email e nome riutilizzabili
  assert.equal(await redis.zcard('lb:easy:all'), 0);
});

test('logout invalida il token; gli errori non rivelano dettagli', async () => {
  const { app } = await makeApp();
  const { body: { token } } = await register(app);
  await app.inject({ method: 'POST', url: '/api/logout', headers: auth(token) });
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: auth(token) })).statusCode, 401);
  const bad = await app.inject({ method: 'POST', url: '/api/games', headers: ip(1), payload: { level: 'x' } });
  assert.equal(bad.statusCode, 400);
  const notFound = await app.inject({ method: 'GET', url: '/api/inesistente' });
  assert.equal(notFound.statusCode, 404);
  assert.equal(json(notFound).error, 'not_found');
});

test('salute, file statici e intestazioni di sicurezza', async () => {
  const { app } = await makeApp();
  assert.equal(json(await app.inject({ method: 'GET', url: '/api/health' })).ok, true);
  const home = await app.inject({ method: 'GET', url: '/' });
  assert.equal(home.statusCode, 200);
  assert.match(home.body, /<title>Sudoku<\/title>/);
  assert.equal(home.headers['x-content-type-options'], 'nosniff');
  const coreJs = await app.inject({ method: 'GET', url: '/sudoku-core.js' });
  assert.equal(coreJs.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/../server/package.json' })).statusCode === 200, false);
});

test('settimana ISO', () => {
  assert.equal(isoWeekKey(new Date(Date.UTC(2026, 0, 1))), '2026-W01');
  assert.equal(isoWeekKey(new Date(Date.UTC(2026, 11, 31))), '2026-W53');
  assert.equal(isoWeekKey(new Date(Date.UTC(2025, 11, 29))), '2026-W01');
});

test('nomi non consentiti e CSP stretta', async () => {
  const { app } = await makeApp();
  for (const name of ['Ciao M3rd@', 'F U C K', 'Vaffanculo1']) {
    const { res } = await register(app, { email: `${Math.random()}@example.com`, name });
    assert.equal(res.statusCode, 400, name);
    assert.equal(json(res).error, 'bad_name');
  }
  // Cognomi comuni che contengono parole "pericolose" devono passare.
  assert.equal((await register(app, { email: 'troiano@example.com', name: 'Troiano' })).res.statusCode, 200);
  assert.equal((await register(app, { email: 'scarpa@example.com', name: 'Giulia Scarpa' })).res.statusCode, 200);

  for (const url of ['/', '/api/health', '/privacy.html']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, url);
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'));
  }
  const https = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-forwarded-proto': 'https' } });
  assert.match(https.headers['strict-transport-security'], /max-age=/);
  assert.equal(json(await app.inject({ method: 'GET', url: '/api/health' })).ok, true);
  assert.equal((await app.inject({ method: 'GET', url: '/robots.txt' })).statusCode, 200);
  // La pagina non deve contenere script o stili inline (la CSP li bloccherebbe).
  const html = (await app.inject({ method: 'GET', url: '/' })).body;
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'script inline');
  assert.ok(!/<style[\s>]/i.test(html) && !/\sstyle="/i.test(html), 'stile inline');
});
