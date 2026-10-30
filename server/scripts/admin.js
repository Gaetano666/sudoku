'use strict';
// Strumento di amministrazione. Dalla VPS:
//   docker exec sudoku node server/scripts/admin.js remove-user "Nome"
//   docker exec sudoku node server/scripts/admin.js top easy
const Redis = require('ioredis');
const { loadConfig } = require('../src/config');
const { deleteUser } = require('../src/users');
const { normalizeName } = require('../src/security');

const LEVELS = ['easy', 'medium', 'hard'];

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const config = loadConfig();
  const redis = new Redis(config.redisUrl, { keyPrefix: config.prefix });
  try {
    if (cmd === 'remove-user' && arg) {
      const name = normalizeName(arg);
      const id = name && await redis.get(`name:${name.key}`);
      if (!id) { console.error(`Utente "${arg}" non trovato`); process.exitCode = 1; return; }
      await deleteUser(redis, id);
      console.log(`Utente "${arg}" eliminato (profilo, sessioni e punteggi).`);
    } else if (cmd === 'top' && LEVELS.includes(arg)) {
      const flat = await redis.zrange(`lb:${arg}:all`, 0, 19, 'WITHSCORES');
      for (let i = 0; i < flat.length; i += 2) {
        const name = await redis.hget(`user:${flat[i]}`, 'name');
        console.log(`${String(i / 2 + 1).padStart(2)}. ${name}  ${(Number(flat[i + 1]) / 1000).toFixed(1)}s`);
      }
    } else {
      console.error('Uso: admin.js remove-user "Nome" | admin.js top <easy|medium|hard>');
      process.exitCode = 1;
    }
  } finally {
    redis.disconnect();
  }
}

main();
