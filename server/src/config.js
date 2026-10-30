'use strict';

// Parametri letti dall'ambiente (vedi .env.example). I valori di default servono per sviluppo e test.
function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const secret = env.SUDOKU_SECRET || '';
  if (production && secret.length < 32) {
    throw new Error('SUDOKU_SECRET mancante o troppo corto (servono almeno 32 caratteri)');
  }
  const int = (name, def) => (env[name] !== undefined && env[name] !== '' ? parseInt(env[name], 10) : def);
  return {
    production,
    port: int('PORT', 3000),
    redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6379',
    prefix: env.REDIS_PREFIX || 'sudoku:',
    secret: secret || 'dev-only-secret-change-me-dev-only-secret',
    publicDir: env.PUBLIC_DIR || require('node:path').join(__dirname, '..', '..', 'public'),
    sessionDays: int('SESSION_DAYS', 365),
    gameTtlSec: int('GAME_TTL_SEC', 24 * 3600),
    // Tempi minimi plausibili per una partita umana (ms): sotto questa soglia il risultato non entra in classifica.
    minMs: {
      easy: int('MIN_MS_EASY', 45_000),
      medium: int('MIN_MS_MEDIUM', 60_000),
      hard: int('MIN_MS_HARD', 90_000),
    },
  };
}

module.exports = { loadConfig };
