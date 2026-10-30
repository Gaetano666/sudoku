'use strict';
const Redis = require('ioredis');
const { loadConfig } = require('./config');
const { buildApp } = require('./app');

const config = loadConfig();
const redis = new Redis(config.redisUrl, { keyPrefix: config.prefix, maxRetriesPerRequest: 2 });
redis.on('error', e => console.error('Redis:', e.message));

const app = buildApp({ redis, config, logger: true });

async function shutdown() {
  await app.close();
  redis.disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen({ port: config.port, host: '0.0.0.0' }).catch(e => {
  console.error(e);
  process.exit(1);
});
