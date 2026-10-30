'use strict';
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const core = require('../../public/sudoku-core.js');
const sec = require('./security');

const LEVELS = Object.keys(core.LEVELS);
const PERIODS = ['all', 'week', 'month'];
const FAIL_LIMIT = 5;          // PIN sbagliati consecutivi prima del blocco temporaneo
const FAIL_WINDOW_SEC = 15 * 60;

function isoWeekKey(date) {
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Chiavi delle classifiche per un livello. Settimana e mese seguono il calendario UTC.
function boardKeys(level, nowMs) {
  const d = new Date(nowMs);
  return {
    all: { key: `lb:${level}:all`, ttl: 0 },
    week: { key: `lb:${level}:w:${isoWeekKey(d)}`, ttl: 21 * 86400 },
    month: { key: `lb:${level}:m:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, ttl: 75 * 86400 },
  };
}

function buildApp({ redis, config, now = Date.now, logger = false }) {
  const app = Fastify({
    logger: logger ? { redact: ['req.headers.authorization'] } : false,
    bodyLimit: 4096,
  });

  const err = (reply, code, error, message, extra = {}) => reply.code(code).send({ error, message, ...extra });
  const clientIp = req => String(req.headers['x-real-ip'] || req.ip || 'unknown');

  // Contatore a finestra fissa su Redis. Restituisce true se la richiesta è ammessa.
  async function allow(key, limit, windowSec) {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowSec);
    return n <= limit;
  }

  async function createSession(userId) {
    const token = sec.newToken();
    const h = sec.sha256(token);
    const ttl = config.sessionDays * 86400;
    await redis.multi().set(`sess:${h}`, userId, 'EX', ttl).sadd(`usess:${userId}`, h).exec();
    return token;
  }

  // Restituisce { id, name } se l'header Authorization contiene un token valido.
  async function authenticate(req) {
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
    if (!m) return null;
    const id = await redis.get(`sess:${sec.sha256(m[1])}`);
    if (!id) return null;
    const name = await redis.hget(`user:${id}`, 'name');
    return name ? { id, name } : null;
  }

  // Hash "finto" per confrontare il tempo di risposta quando l'email non esiste.
  let dummyHash = null;
  const getDummy = async () => (dummyHash ||= await sec.hashPin(config.secret, '000000'));

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((e, req, reply) => {
    if (e.validation || e.statusCode === 400 || e.statusCode === 413) {
      return err(reply, e.statusCode === 413 ? 413 : 400, 'bad_request', 'Richiesta non valida');
    }
    req.log.error(e);
    return err(reply, 500, 'server_error', 'Errore del server');
  });

  // ---------- Salute ----------
  app.get('/api/health', async (req, reply) => {
    try { await redis.ping(); } catch (e) { return err(reply, 503, 'redis_down', 'Redis non raggiungibile'); }
    return { ok: true };
  });

  // ---------- Profilo ----------
  const credentials = {
    type: 'object', additionalProperties: false,
    properties: { email: { type: 'string', maxLength: 254 }, pin: { type: 'string', maxLength: 6 } },
  };

  app.post('/api/register', {
    schema: { body: { ...credentials, required: ['email', 'pin', 'name'], properties: { ...credentials.properties, name: { type: 'string', maxLength: 40 } } } },
  }, async (req, reply) => {
    if (!(await allow(`rl:reg:${clientIp(req)}`, 5, 3600))) return err(reply, 429, 'rate_limited', 'Troppe registrazioni, riprova più tardi');
    const email = sec.normalizeEmail(req.body.email);
    const name = sec.normalizeName(req.body.name);
    if (!email) return err(reply, 400, 'bad_email', 'Email non valida');
    if (!sec.isValidPin(req.body.pin)) return err(reply, 400, 'bad_pin', 'Il PIN deve avere 6 cifre');
    if (!name) return err(reply, 400, 'bad_name', 'Nome non valido: 3-16 caratteri tra lettere, numeri, spazio, punto, trattino e underscore');

    const id = sec.newId();
    const eh = sec.emailHash(config.secret, email);
    const pin = await sec.hashPin(config.secret, req.body.pin);

    // Riserva nome ed email (SET NX): se uno dei due esiste già, annulla.
    if (!(await redis.set(`name:${name.key}`, id, 'NX'))) return err(reply, 409, 'name_taken', 'Questo nome è già in uso');
    if (!(await redis.set(`email:${eh}`, id, 'NX'))) {
      await redis.del(`name:${name.key}`);
      return err(reply, 409, 'email_taken', 'Questa email è già registrata: usa "Accedi"');
    }
    await redis.hset(`user:${id}`, { name: name.display, nameKey: name.key, emailHash: eh, pin, createdAt: now() });
    return { token: await createSession(id), name: name.display };
  });

  app.post('/api/login', { schema: { body: { ...credentials, required: ['email', 'pin'] } } }, async (req, reply) => {
    const ip = clientIp(req);
    if (!(await allow(`rl:login:${ip}`, 40, FAIL_WINDOW_SEC))) return err(reply, 429, 'rate_limited', 'Troppi tentativi, riprova più tardi');
    const email = sec.normalizeEmail(req.body.email);
    const bad = () => err(reply, 401, 'bad_credentials', 'Email o PIN errati');
    if (!email || !sec.isValidPin(req.body.pin)) return bad();

    const eh = sec.emailHash(config.secret, email);
    const failKey = `fail:${eh}`;
    const fails = parseInt(await redis.get(failKey), 10) || 0;
    if (fails >= FAIL_LIMIT) {
      return err(reply, 429, 'locked', 'Troppi PIN errati: riprova tra qualche minuto', { retryAfterSec: await redis.ttl(failKey) });
    }

    const id = await redis.get(`email:${eh}`);
    const user = id ? await redis.hgetall(`user:${id}`) : null;
    const ok = user && user.pin
      ? await sec.verifyPin(config.secret, req.body.pin, user.pin)
      : (await sec.verifyPin(config.secret, req.body.pin, await getDummy()), false);
    if (!ok) {
      const n = await redis.incr(failKey);
      if (n === 1) await redis.expire(failKey, FAIL_WINDOW_SEC);
      return bad();
    }
    await redis.del(failKey);
    return { token: await createSession(id), name: user.name };
  });

  app.post('/api/logout', async (req) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    if (m) {
      const h = sec.sha256(m[1]);
      const id = await redis.get(`sess:${h}`);
      await redis.del(`sess:${h}`);
      if (id) await redis.srem(`usess:${id}`, h);
    }
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    const me = await authenticate(req);
    if (!me) return err(reply, 401, 'auth_required', 'Accesso richiesto');
    const bests = {};
    for (const level of LEVELS) {
      const score = await redis.zscore(`lb:${level}:all`, me.id);
      if (score !== null) bests[level] = { timeMs: Number(score), rank: (await redis.zrank(`lb:${level}:all`, me.id)) + 1 };
    }
    return { name: me.name, bests };
  });

  // Elimina il profilo (diritto alla cancellazione): dati, sessioni e punteggi in tutte le classifiche.
  app.delete('/api/me', { schema: { body: { type: 'object', required: ['pin'], additionalProperties: false, properties: { pin: { type: 'string', maxLength: 6 } } } } }, async (req, reply) => {
    const me = await authenticate(req);
    if (!me) return err(reply, 401, 'auth_required', 'Accesso richiesto');
    const user = await redis.hgetall(`user:${me.id}`);
    if (!sec.isValidPin(req.body.pin) || !(await sec.verifyPin(config.secret, req.body.pin, user.pin))) {
      return err(reply, 401, 'bad_credentials', 'PIN errato');
    }
    const sessions = await redis.smembers(`usess:${me.id}`);
    const tx = redis.multi().del(`user:${me.id}`, `name:${user.nameKey}`, `email:${user.emailHash}`, `usess:${me.id}`);
    for (const h of sessions) tx.del(`sess:${h}`);
    await tx.exec();
    // Le chiavi restituite da SCAN includono il prefisso di ioredis: va tolto prima di riusarle.
    const prefix = redis.options.keyPrefix || '';
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}lb:*`, 'COUNT', 200);
      cursor = next;
      for (const key of keys) await redis.zrem(key.slice(prefix.length), me.id);
    } while (cursor !== '0');
    return { ok: true };
  });

  // ---------- Partite in classifica ----------
  app.post('/api/games', { schema: { body: { type: 'object', required: ['level'], additionalProperties: false, properties: { level: { type: 'string', maxLength: 10 } } } } }, async (req, reply) => {
    if (!LEVELS.includes(req.body.level)) return err(reply, 400, 'bad_level', 'Livello non valido');
    if (!(await allow(`rl:games:${clientIp(req)}`, 60, 600))) return err(reply, 429, 'rate_limited', 'Troppe partite create, riprova più tardi');
    const { puzzle, solution } = core.generate(req.body.level);
    const id = sec.newId();
    const startedAt = now();
    await redis.multi()
      .hset(`game:${id}`, { level: req.body.level, puzzle: puzzle.join(''), solution: solution.join(''), startedAt })
      .expire(`game:${id}`, config.gameTtlSec)
      .exec();
    return { gameId: id, level: req.body.level, puzzle: puzzle.join(''), startedAt };
  });

  app.post('/api/games/:id/finish', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', maxLength: 40 } } },
      body: { type: 'object', required: ['solution'], additionalProperties: false, properties: { solution: { type: 'string', maxLength: 81 }, hints: { type: 'integer', minimum: 0, maximum: 999 } } },
    },
  }, async (req, reply) => {
    const me = await authenticate(req);
    if (!me) return err(reply, 401, 'auth_required', 'Accedi o crea un profilo per entrare in classifica');
    if (!(await allow(`rl:finish:${clientIp(req)}`, 60, 600))) return err(reply, 429, 'rate_limited', 'Troppe richieste, riprova più tardi');

    const gameKey = `game:${req.params.id}`;
    const game = await redis.hgetall(gameKey);
    if (!game.solution) return err(reply, 404, 'game_not_found', 'Partita non trovata o scaduta');
    if (req.body.solution !== game.solution) return err(reply, 422, 'wrong_solution', 'La soluzione non è corretta');
    // Una partita si chiude una sola volta.
    if (!(await redis.set(`gamedone:${req.params.id}`, '1', 'NX', 'EX', config.gameTtlSec))) {
      return err(reply, 409, 'already_finished', 'Partita già conclusa');
    }

    const timeMs = now() - Number(game.startedAt);
    const hints = req.body.hints || 0;
    if (hints > 0) return { ranked: false, reason: 'hints', timeMs };
    if (timeMs < (config.minMs[game.level] ?? 0)) return { ranked: false, reason: 'too_fast', timeMs };

    const boards = boardKeys(game.level, now());
    const result = { ranked: true, timeMs, personalBest: false, ranks: {} };
    for (const period of PERIODS) {
      const { key, ttl } = boards[period];
      const prev = await redis.zscore(key, me.id);
      await redis.zadd(key, 'LT', timeMs, me.id);       // tiene solo il tempo migliore
      if (ttl) await redis.expire(key, ttl);
      result.ranks[period] = (await redis.zrank(key, me.id)) + 1;
      if (period === 'all' && (prev === null || timeMs < Number(prev))) result.personalBest = true;
    }
    return result;
  });

  // ---------- Classifica ----------
  app.get('/api/leaderboard', {
    schema: {
      querystring: {
        type: 'object',
        properties: { level: { type: 'string' }, period: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      },
    },
  }, async (req, reply) => {
    const level = req.query.level || 'easy';
    const period = req.query.period || 'all';
    const limit = req.query.limit || 50;
    if (!LEVELS.includes(level) || !PERIODS.includes(period)) return err(reply, 400, 'bad_request', 'Parametri non validi');
    if (!(await allow(`rl:lb:${clientIp(req)}`, 120, 60))) return err(reply, 429, 'rate_limited', 'Troppe richieste');

    const { key } = boardKeys(level, now())[period];
    const flat = await redis.zrange(key, 0, limit - 1, 'WITHSCORES');
    const ids = [], scores = [];
    for (let i = 0; i < flat.length; i += 2) { ids.push(flat[i]); scores.push(Number(flat[i + 1])); }
    const pipe = redis.pipeline();
    ids.forEach(id => pipe.hget(`user:${id}`, 'name'));
    const names = ids.length ? (await pipe.exec()).map(r => r[1]) : [];
    const entries = [];
    ids.forEach((id, i) => { if (names[i]) entries.push({ rank: i + 1, name: names[i], timeMs: scores[i] }); });

    let mine = null;
    const me = await authenticate(req);
    if (me) {
      const score = await redis.zscore(key, me.id);
      if (score !== null) mine = { rank: (await redis.zrank(key, me.id)) + 1, timeMs: Number(score) };
    }
    return { level, period, total: await redis.zcard(key), entries, me: mine };
  });

  app.all('/api/*', async (req, reply) => err(reply, 404, 'not_found', 'Risorsa non trovata'));

  // ---------- File statici (il gioco) ----------
  app.register(fastifyStatic, {
    root: config.publicDir,
    setHeaders: reply => reply.header('Cache-Control', 'no-cache'),
  });

  return app;
}

module.exports = { buildApp, boardKeys, isoWeekKey };
