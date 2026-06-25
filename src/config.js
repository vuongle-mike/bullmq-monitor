'use strict';

function readIntEnv(name, defaultValue) {
  const value = Number.parseInt(process.env[name] || String(defaultValue), 10);
  return Number.isFinite(value) ? value : defaultValue;
}

function createConfig() {
  return {
    host: process.env.HOST || '127.0.0.1',
    port: readIntEnv('PORT', 3100),
    redisHost: process.env.REDIS_HOST || 'localhost',
    redisPort: readIntEnv('REDIS_PORT', 16379),
    queueName: process.env.QUEUE_NAME || 'yourQueueName',
    basePath: process.env.BASE_PATH || '/admin/queues',
    livePath: process.env.LIVE_PATH || '/live',
  };
}

function createRedisOptions(config) {
  return {
    host: config.redisHost,
    port: config.redisPort,
    maxRetriesPerRequest: null,
  };
}

function redisLabel(config) {
  return `${config.redisHost}:${config.redisPort}`;
}

module.exports = {
  createConfig,
  createRedisOptions,
  redisLabel,
};
