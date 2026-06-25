'use strict';

const fs = require('fs');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

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
  loadEnvFile,
  redisLabel,
};
