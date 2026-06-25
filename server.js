'use strict';

const path = require('path');
const express = require('express');
const { Queue, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');

const { createConfig, createRedisOptions } = require('./src/config');
const { JOB_STATUSES } = require('./src/constants');
const { loadEnvFile } = require('./src/env');
const { renderLivePage } = require('./src/live-page');
const { registerRoutes } = require('./src/routes');
const { createJobSerializers } = require('./src/serializers');
const { createSseHub } = require('./src/sse');

loadEnvFile(path.join(__dirname, '.env'));

const config = createConfig();
const redisOptions = createRedisOptions(config);

const app = express();
const connection = new IORedis(redisOptions);
const queue = new Queue(config.queueName, { connection });
const queueEvents = new QueueEvents(config.queueName, { connection: redisOptions });
const serverAdapter = new ExpressAdapter();
const sockets = new Set();

let isShuttingDown = false;

serverAdapter.setBasePath(config.basePath);

createBullBoard({
  queues: [new BullMQAdapter(queue)],
  serverAdapter,
});

const sseHub = createSseHub({
  config,
  queueEvents,
  isShuttingDown: () => isShuttingDown,
});

registerRoutes({
  app,
  config,
  connection,
  jobStatuses: JOB_STATUSES,
  queue,
  renderLivePage,
  serializers: createJobSerializers(queue),
  sseHub,
});

app.use(config.basePath, serverAdapter.getRouter());

const server = app.listen(config.port, config.host, () => {
  console.log(`BullMQ realtime monitor running at http://${config.host}:${config.port}${config.livePath}`);
  console.log(`Bull Board running at http://${config.host}:${config.port}${config.basePath}`);
  console.log(`Redis: ${config.redisHost}:${config.redisPort}`);
  console.log(`Queue: ${config.queueName}`);
});

server.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

async function closeResources() {
  await queueEvents.close();
  await queue.close();
  await connection.quit();
}

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}. Closing BullMQ monitor...`);

  sseHub.closeClients();

  const forceCloseTimer = setTimeout(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
  }, 3000);

  server.close(async () => {
    clearTimeout(forceCloseTimer);

    try {
      await closeResources();
    } finally {
      process.exit(0);
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
