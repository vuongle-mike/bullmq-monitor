'use strict';

const { QUEUE_EVENT_NAMES } = require('./constants');
const { toPlainValue } = require('./serializers');

function sendSse(res, type, payload) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function createEventPayload(config, event, args, eventId) {
  return {
    event,
    eventId: eventId || null,
    queue: config.queueName,
    timestamp: new Date().toISOString(),
    args: toPlainValue(args),
  };
}

function createSseHub({ config, queueEvents, isShuttingDown }) {
  const clients = new Set();

  function broadcast(type, payload) {
    for (const client of clients) {
      sendSse(client.res, type, payload);
    }
  }

  function makePayload(event, args, eventId) {
    return createEventPayload(config, event, args, eventId);
  }

  function handleRequest(req, res) {
    if (isShuttingDown()) {
      res.status(503).end('Server is shutting down');
      return;
    }

    res.set({
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const client = {
      res,
      heartbeat: null,
    };
    clients.add(client);

    sendSse(res, 'connected', makePayload('connected', { clientCount: clients.size }, null));

    client.heartbeat = setInterval(() => {
      sendSse(res, 'heartbeat', makePayload('heartbeat', {}, null));
    }, 30000);

    const cleanup = () => {
      clearInterval(client.heartbeat);
      clients.delete(client);
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  function closeClients() {
    for (const client of clients) {
      clearInterval(client.heartbeat);
      sendSse(client.res, 'shutdown', makePayload('shutdown', {}, null));
      client.res.end();
    }
    clients.clear();
  }

  for (const eventName of QUEUE_EVENT_NAMES) {
    queueEvents.on(eventName, (args, eventId) => {
      broadcast('queue-event', makePayload(eventName, args, eventId));
    });
  }

  queueEvents.on('error', error => {
    broadcast('error', makePayload('error', { message: error.message }, null));
    console.error('QueueEvents error:', error);
  });

  return {
    closeClients,
    handleRequest,
  };
}

module.exports = {
  createSseHub,
};
