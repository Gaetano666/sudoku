'use strict';

// Cancella tutto ciò che riguarda un utente: profilo, riserve di nome ed email, sessioni e punteggi.
// Serve sia al "Elimina profilo" dell'utente sia allo strumento di amministrazione.
async function deleteUser(redis, id) {
  const user = await redis.hgetall(`user:${id}`);
  const sessions = await redis.smembers(`usess:${id}`);
  const tx = redis.multi().del(`user:${id}`, `usess:${id}`);
  if (user.nameKey) tx.del(`name:${user.nameKey}`);
  if (user.emailHash) tx.del(`email:${user.emailHash}`);
  for (const h of sessions) tx.del(`sess:${h}`);
  await tx.exec();

  // Le chiavi restituite da SCAN includono il prefisso di ioredis: va tolto prima di riusarle.
  const prefix = redis.options.keyPrefix || '';
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}lb:*`, 'COUNT', 200);
    cursor = next;
    for (const key of keys) await redis.zrem(key.slice(prefix.length), id);
  } while (cursor !== '0');
}

module.exports = { deleteUser };
