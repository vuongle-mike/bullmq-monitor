'use strict';

const { redisLabel } = require('./config');

const JOB_STATUSES = [
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'completed',
  'failed',
  'waiting-children',
];

const QUEUE_EVENT_NAMES = [
  'active',
  'added',
  'cleaned',
  'completed',
  'debounced',
  'deduplicated',
  'delayed',
  'drained',
  'duplicated',
  'failed',
  'paused',
  'progress',
  'removed',
  'resumed',
  'retries-exhausted',
  'stalled',
  'waiting',
  'waiting-children',
];

function createMonitor({ config, connection, queue, queueEvents, isShuttingDown }) {
  const events = createEventStream({ config, queueEvents, isShuttingDown });

  return {
    events,
    jobStatuses: JOB_STATUSES,
    getHealth: () => getHealth({ config, connection }),
    getJob: jobId => getJob({ jobId, queue }),
    getJobs: query => getJobs({ query, queue }),
    getSummary: () => getSummary({ config, queue }),
  };
}

async function getHealth({ config, connection }) {
  const pong = await connection.ping();

  return {
    ok: pong === 'PONG',
    redis: redisLabel(config),
    queue: config.queueName,
  };
}

async function getSummary({ config, queue }) {
  const [counts, isPaused, workersCount] = await Promise.all([
    queue.getJobCounts(...JOB_STATUSES),
    queue.isPaused(),
    queue.getWorkersCount().catch(() => null),
  ]);
  const normalizedCounts = normalizeCounts(counts);

  return {
    queue: config.queueName,
    redis: redisLabel(config),
    bullBoardPath: config.basePath,
    livePath: config.livePath,
    paused: isPaused,
    workersCount,
    counts: normalizedCounts,
    total: Object.values(normalizedCounts).reduce((sum, count) => sum + count, 0),
    updatedAt: new Date().toISOString(),
  };
}

async function getJobs({ query, queue }) {
  const status = query.status || 'waiting';

  if (!JOB_STATUSES.includes(status)) {
    const error = new Error(`Unknown status "${status}"`);
    error.statusCode = 400;
    error.allowedStatuses = JOB_STATUSES;
    throw error;
  }

  const range = parseRange(query);
  const [jobIds, counts] = await Promise.all([
    queue.getRanges([status], range.start, range.end, range.asc),
    queue.getJobCounts(status),
  ]);
  const client = await queue.client;
  const jobFields = await getJobSummaryFields(client, queue, jobIds);

  return {
    status,
    jobs: jobIds.map((jobId, index) => serializeJobSummary(jobId, jobFields[index], status)),
    pagination: {
      start: range.start,
      end: range.end,
      count: jobIds.length,
      total: counts[status] || 0,
      asc: range.asc,
    },
  };
}

async function getJob({ jobId, queue }) {
  const job = await queue.getJob(jobId);

  if (!job) {
    const error = new Error('Job not found');
    error.statusCode = 404;
    throw error;
  }

  return serializeJob(job, await queue.getJobState(job.id));
}

async function getJobSummaryFields(client, queue, jobIds) {
  if (jobIds.length === 0) {
    return [];
  }

  const pipeline = client.pipeline();

  for (const jobId of jobIds) {
    pipeline.hmget(
      queue.toKey(jobId),
      'name',
      'progress',
      'atm',
      'ats',
      'failedReason',
      'delay',
      'priority',
      'timestamp',
      'processedOn',
      'finishedOn'
    );
  }

  return (await pipeline.exec()).map(([error, fields]) => {
    if (error) {
      throw error;
    }

    return fields;
  });
}

function serializeJob(job, status) {
  return {
    id: job.id,
    name: job.name,
    status,
    data: toPlainValue(job.data),
    progress: toPlainValue(job.progress),
    attemptsMade: job.attemptsMade,
    attemptsStarted: job.attemptsStarted,
    failedReason: job.failedReason || null,
    returnvalue: toPlainValue(job.returnvalue),
    stacktrace: toPlainValue(job.stacktrace || []),
    opts: toPlainValue(job.opts),
    delay: job.delay,
    priority: job.priority,
    timestamp: job.timestamp,
    processedOn: job.processedOn || null,
    finishedOn: job.finishedOn || null,
    processedBy: job.processedBy || null,
    parent: toPlainValue(job.parent || null),
    repeatJobKey: job.repeatJobKey || null,
  };
}

function serializeJobSummary(jobId, fields, status) {
  const [
    name,
    progress,
    attemptsMade,
    attemptsStarted,
    failedReason,
    delay,
    priority,
    timestamp,
    processedOn,
    finishedOn,
  ] = fields;

  return {
    id: jobId,
    name: name || '',
    status,
    progress: parseJsonField(progress, 0),
    attemptsMade: parseIntegerField(attemptsMade),
    attemptsStarted: parseIntegerField(attemptsStarted),
    failedReason: failedReason || null,
    delay: parseIntegerField(delay),
    priority: parseIntegerField(priority),
    timestamp: parseIntegerField(timestamp) || null,
    processedOn: parseIntegerField(processedOn) || null,
    finishedOn: parseIntegerField(finishedOn) || null,
  };
}

function createEventStream({ config, queueEvents, isShuttingDown }) {
  const clients = new Set();

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

    const client = { res, heartbeat: null };
    clients.add(client);
    sendSse(res, 'connected', makeEventPayload(config, 'connected', { clientCount: clients.size }));

    client.heartbeat = setInterval(() => {
      sendSse(res, 'heartbeat', makeEventPayload(config, 'heartbeat', {}));
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
      sendSse(client.res, 'shutdown', makeEventPayload(config, 'shutdown', {}));
      client.res.end();
    }
    clients.clear();
  }

  function broadcast(type, payload) {
    for (const client of clients) {
      sendSse(client.res, type, payload);
    }
  }

  for (const eventName of QUEUE_EVENT_NAMES) {
    queueEvents.on(eventName, (args, eventId) => {
      broadcast('queue-event', makeEventPayload(config, eventName, args, eventId));
    });
  }

  queueEvents.on('error', error => {
    broadcast('error', makeEventPayload(config, 'error', { message: error.message }));
    console.error('QueueEvents error:', error);
  });

  return {
    closeClients,
    handleRequest,
  };
}

function sendSse(res, type, payload) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function makeEventPayload(config, event, args, eventId = null) {
  return {
    event,
    eventId,
    queue: config.queueName,
    timestamp: new Date().toISOString(),
    args: toPlainValue(args),
  };
}

function normalizeCounts(counts) {
  return Object.fromEntries(JOB_STATUSES.map(status => [status, counts[status] || 0]));
}

function parseRange(query) {
  const start = Math.max(0, Number.parseInt(query.start || '0', 10) || 0);
  const requestedEnd = Number.parseInt(query.end || '49', 10);
  const end = Number.isFinite(requestedEnd) ? Math.max(start, requestedEnd) : start + 49;

  return {
    start,
    end: Math.min(end, start + 99),
    asc: String(query.asc || 'false') === 'true',
  };
}

function parseIntegerField(value) {
  const parsed = Number.parseInt(value || '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseJsonField(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return value;
  }
}

function toPlainValue(value) {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return String(value);
  }
}

module.exports = {
  createMonitor,
};
