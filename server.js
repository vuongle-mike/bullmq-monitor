'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Queue, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');

const JOB_STATUSES = [
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'completed',
  'failed',
  'waiting-children',
];

loadEnvFile(path.join(__dirname, '.env'));

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

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number.parseInt(process.env.PORT || '3100', 10),
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: Number.parseInt(process.env.REDIS_PORT || '16379', 10),
  queueName: process.env.QUEUE_NAME || 'yourQueueName',
  basePath: process.env.BASE_PATH || '/admin/queues',
  livePath: process.env.LIVE_PATH || '/live',
};

const redisOptions = {
  host: config.redisHost,
  port: config.redisPort,
  maxRetriesPerRequest: null,
};

const connection = new IORedis(redisOptions);
const queue = new Queue(config.queueName, { connection });
const queueEvents = new QueueEvents(config.queueName, { connection: redisOptions });
const serverAdapter = new ExpressAdapter();
const sseClients = new Set();
const sockets = new Set();
let isShuttingDown = false;

serverAdapter.setBasePath(config.basePath);

createBullBoard({
  queues: [new BullMQAdapter(queue)],
  serverAdapter,
});

const app = express();

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

async function serializeJob(job, status) {
  return {
    id: job.id,
    name: job.name,
    status: status || (await queue.getJobState(job.id)),
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

async function serializeJobSummary(job, status) {
  return {
    id: job.id,
    name: job.name,
    status: status || (await queue.getJobState(job.id)),
    progress: toPlainValue(job.progress),
    attemptsMade: job.attemptsMade,
    attemptsStarted: job.attemptsStarted,
    failedReason: job.failedReason || null,
    delay: job.delay,
    priority: job.priority,
    timestamp: job.timestamp,
    processedOn: job.processedOn || null,
    finishedOn: job.finishedOn || null,
  };
}

function parseRange(query) {
  const start = Math.max(0, Number.parseInt(query.start || '0', 10) || 0);
  const requestedEnd = Number.parseInt(query.end || '49', 10);
  const end = Number.isFinite(requestedEnd) ? Math.max(start, requestedEnd) : start + 49;
  const cappedEnd = Math.min(end, start + 99);

  return {
    start,
    end: cappedEnd,
    asc: String(query.asc || 'false') === 'true',
  };
}

function normalizeCounts(counts) {
  return Object.fromEntries(JOB_STATUSES.map(status => [status, counts[status] || 0]));
}

function sendSse(res, type, payload) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastSse(type, payload) {
  for (const client of sseClients) {
    sendSse(client.res, type, payload);
  }
}

function makeEventPayload(event, args, eventId) {
  return {
    event,
    eventId: eventId || null,
    queue: config.queueName,
    timestamp: new Date().toISOString(),
    args: toPlainValue(args),
  };
}

for (const eventName of QUEUE_EVENT_NAMES) {
  queueEvents.on(eventName, (args, eventId) => {
    broadcastSse('queue-event', makeEventPayload(eventName, args, eventId));
  });
}

queueEvents.on('error', error => {
  broadcastSse('error', makeEventPayload('error', { message: error.message }, null));
  console.error('QueueEvents error:', error);
});

app.get('/', (req, res) => {
  res.redirect(config.livePath);
});

app.get('/health', async (req, res) => {
  try {
    const pong = await connection.ping();
    res.json({
      ok: pong === 'PONG',
      redis: `${config.redisHost}:${config.redisPort}`,
      queue: config.queueName,
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error.message,
      redis: `${config.redisHost}:${config.redisPort}`,
      queue: config.queueName,
    });
  }
});

app.get('/api/queue/summary', async (req, res) => {
  try {
    const [counts, isPaused, workersCount] = await Promise.all([
      queue.getJobCounts(...JOB_STATUSES),
      queue.isPaused(),
      queue.getWorkersCount().catch(() => null),
    ]);
    const normalizedCounts = normalizeCounts(counts);

    res.json({
      queue: config.queueName,
      redis: `${config.redisHost}:${config.redisPort}`,
      bullBoardPath: config.basePath,
      livePath: config.livePath,
      paused: isPaused,
      workersCount,
      counts: normalizedCounts,
      total: Object.values(normalizedCounts).reduce((sum, count) => sum + count, 0),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error.message,
      queue: config.queueName,
      redis: `${config.redisHost}:${config.redisPort}`,
    });
  }
});

app.get('/api/jobs', async (req, res) => {
  const status = req.query.status || 'waiting';

  if (!JOB_STATUSES.includes(status)) {
    res.status(400).json({
      error: `Unknown status "${status}"`,
      allowedStatuses: JOB_STATUSES,
    });
    return;
  }

  const range = parseRange(req.query);

  try {
    const [jobs, counts] = await Promise.all([
      queue.getJobs([status], range.start, range.end, range.asc),
      queue.getJobCounts(status),
    ]);

    res.json({
      status,
      jobs: await Promise.all(jobs.map(job => serializeJobSummary(job, status))),
      pagination: {
        start: range.start,
        end: range.end,
        count: jobs.length,
        total: counts[status] || 0,
        asc: range.asc,
      },
    });
  } catch (error) {
    res.status(503).json({
      error: error.message,
      status,
    });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const job = await queue.getJob(req.params.id);

    if (!job) {
      res.status(404).json({
        error: 'Job not found',
        id: req.params.id,
      });
      return;
    }

    res.json(await serializeJob(job));
  } catch (error) {
    res.status(503).json({
      error: error.message,
      id: req.params.id,
    });
  }
});

app.get(`${config.livePath}/events`, (req, res) => {
  if (isShuttingDown) {
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
  sseClients.add(client);
  sendSse(res, 'connected', makeEventPayload('connected', { clientCount: sseClients.size }, null));

  client.heartbeat = setInterval(() => {
    sendSse(res, 'heartbeat', makeEventPayload('heartbeat', {}, null));
  }, 30000);

  const cleanup = () => {
    clearInterval(client.heartbeat);
    sseClients.delete(client);
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
});

app.get(config.livePath, (req, res) => {
  res.type('html').send(renderLivePage());
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

function closeSseClients() {
  for (const client of sseClients) {
    clearInterval(client.heartbeat);
    sendSse(client.res, 'shutdown', makeEventPayload('shutdown', {}, null));
    client.res.end();
  }
  sseClients.clear();
}

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}. Closing BullMQ monitor...`);

  closeSseClients();

  const forceCloseTimer = setTimeout(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
  }, 3000);

  server.close(async () => {
    clearTimeout(forceCloseTimer);
    try {
      await queueEvents.close();
      await queue.close();
      await connection.quit();
    } finally {
      process.exit(0);
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function renderLivePage() {
  const statuses = JSON.stringify(JOB_STATUSES);
  const queueName = JSON.stringify(config.queueName);
  const bullBoardPath = JSON.stringify(config.basePath);
  const livePath = JSON.stringify(config.livePath);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BullMQ Live Monitor</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #1f2937;
      --muted: #6b7280;
      --line: #d9dee7;
      --accent: #0f766e;
      --accent-soft: #d9f4ef;
      --danger: #b42318;
      --warn: #9a6700;
      --ok: #0b7a3b;
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111827;
        --panel: #182231;
        --text: #eef2f7;
        --muted: #9ca3af;
        --line: #2d394b;
        --accent: #5eead4;
        --accent-soft: #123b3a;
        --danger: #fb7185;
        --warn: #fbbf24;
        --ok: #86efac;
        --shadow: none;
      }
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-width: 320px;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
    }

    button, select {
      font: inherit;
    }

    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }

    header {
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      box-shadow: var(--shadow);
    }

    .header-inner {
      max-width: 1440px;
      margin: 0 auto;
      padding: 18px 24px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: center;
    }

    h1 {
      margin: 0;
      font-size: 21px;
      font-weight: 700;
      letter-spacing: 0;
    }

    .subtitle {
      margin-top: 5px;
      color: var(--muted);
      font-size: 13px;
    }

    .header-actions {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .button {
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--text);
      background: var(--panel);
      padding: 0 12px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      cursor: pointer;
    }

    .button:hover {
      border-color: var(--accent);
    }

    .status-pill {
      min-height: 36px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0 12px;
      color: var(--muted);
      background: var(--panel);
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--muted);
    }

    .dot.connected { background: var(--ok); }
    .dot.reconnecting { background: var(--warn); }
    .dot.disconnected { background: var(--danger); }

    main {
      width: 100%;
      max-width: 1440px;
      margin: 0 auto;
      padding: 20px 24px 32px;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(7, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }

    .metric {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 12px;
      min-height: 82px;
    }

    .metric-label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }

    .metric-value {
      margin-top: 8px;
      font-size: 25px;
      font-weight: 700;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
      gap: 16px;
      align-items: start;
    }

    .panel {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      overflow: hidden;
    }

    .panel-header {
      padding: 14px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }

    .panel-title {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
    }

    .tabs {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
    }

    .tab {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: transparent;
      color: var(--text);
      padding: 7px 10px;
      cursor: pointer;
      white-space: nowrap;
    }

    .tab.active {
      background: var(--accent-soft);
      border-color: var(--accent);
      color: var(--accent);
    }

    .table-wrap {
      overflow: auto;
      min-height: 430px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 760px;
    }

    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }

    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      background: color-mix(in srgb, var(--panel), var(--bg) 35%);
      position: sticky;
      top: 0;
    }

    tr {
      cursor: pointer;
    }

    tr:hover td {
      background: color-mix(in srgb, var(--panel), var(--accent-soft) 22%);
    }

    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }

    .muted {
      color: var(--muted);
    }

    .detail {
      padding: 14px;
    }

    .detail-empty {
      color: var(--muted);
      min-height: 420px;
      display: grid;
      place-items: center;
      text-align: center;
      padding: 24px;
    }

    .field {
      margin-bottom: 14px;
    }

    .field-label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      margin-bottom: 5px;
    }

    pre {
      margin: 0;
      max-height: 280px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: var(--bg);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .events {
      display: flex;
      gap: 8px;
      align-items: center;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
    }

    .event-name {
      color: var(--accent);
      font-weight: 700;
    }

    .error-text {
      color: var(--danger);
      padding: 12px 14px;
      border-top: 1px solid var(--line);
      display: none;
    }

    .error-text.visible {
      display: block;
    }

    @media (max-width: 1100px) {
      .summary {
        grid-template-columns: repeat(3, minmax(120px, 1fr));
      }

      .layout {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 720px) {
      .header-inner {
        grid-template-columns: 1fr;
        padding: 16px;
      }

      .header-actions {
        justify-content: flex-start;
      }

      main {
        padding: 16px;
      }

      .summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .panel-header {
        align-items: flex-start;
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="header-inner">
        <div>
          <h1>BullMQ Live Monitor</h1>
          <div class="subtitle">Queue <span id="queueName" class="mono"></span> on <span id="redisName" class="mono"></span></div>
        </div>
        <div class="header-actions">
          <span class="status-pill"><span id="connectionDot" class="dot disconnected"></span><span id="connectionText">disconnected</span></span>
          <button id="refreshButton" class="button" type="button">Refresh</button>
          <a id="bullBoardLink" class="button" href="#">Bull Board</a>
        </div>
      </div>
    </header>

    <main>
      <section id="summary" class="summary"></section>

      <section class="layout">
        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Jobs</h2>
            <div class="events">
              <span>Last event</span>
              <span id="lastEvent" class="event-name">none</span>
              <span id="lastUpdated">never</span>
            </div>
          </div>
          <div id="tabs" class="tabs"></div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Attempts</th>
                  <th>Progress</th>
                  <th>Created</th>
                  <th>Finished</th>
                </tr>
              </thead>
              <tbody id="jobsBody"></tbody>
            </table>
          </div>
          <div id="jobsError" class="error-text"></div>
        </div>

        <aside class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Job Detail</h2>
          </div>
          <div id="detail" class="detail-empty">Select a job to inspect its payload and state.</div>
        </aside>
      </section>
    </main>
  </div>

  <script>
    const JOB_STATUSES = ${statuses};
    const QUEUE_NAME = ${queueName};
    const BULL_BOARD_PATH = ${bullBoardPath};
    const LIVE_PATH = ${livePath};
    const state = {
      status: 'waiting',
      selectedJobId: null,
      refreshTimer: null,
      source: null,
    };

    const summaryEl = document.getElementById('summary');
    const tabsEl = document.getElementById('tabs');
    const jobsBodyEl = document.getElementById('jobsBody');
    const detailEl = document.getElementById('detail');
    const jobsErrorEl = document.getElementById('jobsError');
    const queueNameEl = document.getElementById('queueName');
    const redisNameEl = document.getElementById('redisName');
    const lastEventEl = document.getElementById('lastEvent');
    const lastUpdatedEl = document.getElementById('lastUpdated');
    const connectionDotEl = document.getElementById('connectionDot');
    const connectionTextEl = document.getElementById('connectionText');

    queueNameEl.textContent = QUEUE_NAME;
    document.getElementById('bullBoardLink').href = BULL_BOARD_PATH;
    document.getElementById('refreshButton').addEventListener('click', () => refreshAll());

    function setConnection(status) {
      connectionDotEl.className = 'dot ' + status;
      connectionTextEl.textContent = status;
    }

    function formatDate(value) {
      if (!value) return '-';
      return new Date(value).toLocaleString();
    }

    function formatJson(value) {
      return JSON.stringify(value, null, 2);
    }

    function showError(message) {
      jobsErrorEl.textContent = message || '';
      jobsErrorEl.classList.toggle('visible', Boolean(message));
    }

    function renderTabs(counts = {}) {
      tabsEl.innerHTML = '';
      for (const status of JOB_STATUSES) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tab' + (status === state.status ? ' active' : '');
        button.textContent = status + ' (' + (counts[status] || 0) + ')';
        button.addEventListener('click', () => {
          state.status = status;
          state.selectedJobId = null;
          detailEl.className = 'detail-empty';
          detailEl.textContent = 'Select a job to inspect its payload and state.';
          refreshAll();
        });
        tabsEl.appendChild(button);
      }
    }

    function renderSummary(summary) {
      redisNameEl.textContent = summary.redis;
      summaryEl.innerHTML = '';

      for (const status of JOB_STATUSES) {
        const item = document.createElement('div');
        item.className = 'metric';
        item.innerHTML = '<div class="metric-label"></div><div class="metric-value"></div>';
        item.querySelector('.metric-label').textContent = status;
        item.querySelector('.metric-value').textContent = summary.counts[status] || 0;
        summaryEl.appendChild(item);
      }
    }

    function renderJobs(payload) {
      jobsBodyEl.innerHTML = '';

      if (payload.jobs.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="6" class="muted">No jobs in this status.</td>';
        jobsBodyEl.appendChild(row);
        return;
      }

      for (const job of payload.jobs) {
        const row = document.createElement('tr');
        row.innerHTML = [
          '<td class="mono"></td>',
          '<td></td>',
          '<td></td>',
          '<td class="mono"></td>',
          '<td></td>',
          '<td></td>',
        ].join('');
        row.children[0].textContent = job.id;
        row.children[1].textContent = job.name;
        row.children[2].textContent = job.attemptsMade + ' / ' + (job.opts?.attempts || 1);
        row.children[3].textContent = typeof job.progress === 'object' ? JSON.stringify(job.progress) : job.progress;
        row.children[4].textContent = formatDate(job.timestamp);
        row.children[5].textContent = formatDate(job.finishedOn);
        row.addEventListener('click', () => loadDetail(job.id));
        jobsBodyEl.appendChild(row);
      }
    }

    function renderDetail(job) {
      detailEl.className = 'detail';
      detailEl.innerHTML = [
        '<div class="field"><div class="field-label">ID</div><div class="mono"></div></div>',
        '<div class="field"><div class="field-label">Name</div><div></div></div>',
        '<div class="field"><div class="field-label">Status</div><div></div></div>',
        '<div class="field"><div class="field-label">Timing</div><pre></pre></div>',
        '<div class="field"><div class="field-label">Data</div><pre></pre></div>',
        '<div class="field"><div class="field-label">Progress</div><pre></pre></div>',
        '<div class="field"><div class="field-label">Result / Failure</div><pre></pre></div>',
        '<div class="field"><div class="field-label">Options</div><pre></pre></div>',
      ].join('');

      const fields = detailEl.querySelectorAll('.field');
      fields[0].querySelector('div:last-child').textContent = job.id;
      fields[1].querySelector('div:last-child').textContent = job.name;
      fields[2].querySelector('div:last-child').textContent = job.status;
      fields[3].querySelector('pre').textContent = formatJson({
        created: formatDate(job.timestamp),
        processed: formatDate(job.processedOn),
        finished: formatDate(job.finishedOn),
        delay: job.delay,
      });
      fields[4].querySelector('pre').textContent = formatJson(job.data);
      fields[5].querySelector('pre').textContent = formatJson(job.progress);
      fields[6].querySelector('pre').textContent = formatJson({
        returnvalue: job.returnvalue,
        failedReason: job.failedReason,
        stacktrace: job.stacktrace,
      });
      fields[7].querySelector('pre').textContent = formatJson(job.opts);
    }

    async function fetchJson(path) {
      const response = await fetch(path, { headers: { Accept: 'application/json' } });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(body.error || response.statusText);
      }

      return body;
    }

    async function refreshSummary() {
      const summary = await fetchJson('/api/queue/summary');
      renderSummary(summary);
      renderTabs(summary.counts);
      lastUpdatedEl.textContent = new Date(summary.updatedAt).toLocaleTimeString();
    }

    async function refreshJobs() {
      const jobs = await fetchJson('/api/jobs?status=' + encodeURIComponent(state.status));
      renderJobs(jobs);
    }

    async function refreshAll() {
      try {
        showError('');
        await Promise.all([refreshSummary(), refreshJobs()]);
        if (state.selectedJobId) {
          await loadDetail(state.selectedJobId, true);
        }
      } catch (error) {
        showError(error.message);
      }
    }

    async function loadDetail(jobId, keepQuiet = false) {
      try {
        state.selectedJobId = jobId;
        const job = await fetchJson('/api/jobs/' + encodeURIComponent(jobId));
        renderDetail(job);
      } catch (error) {
        if (!keepQuiet) {
          showError(error.message);
        }
      }
    }

    function scheduleRefresh() {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = setTimeout(() => refreshAll(), 250);
    }

    function connectEvents() {
      setConnection('reconnecting');
      state.source = new EventSource(LIVE_PATH + '/events');

      state.source.addEventListener('connected', event => {
        setConnection('connected');
        lastEventEl.textContent = JSON.parse(event.data).event;
        refreshAll();
      });

      state.source.addEventListener('queue-event', event => {
        const payload = JSON.parse(event.data);
        lastEventEl.textContent = payload.event;
        scheduleRefresh();
      });

      state.source.addEventListener('error', event => {
        if (event.data) {
          const payload = JSON.parse(event.data);
          showError(payload.args?.message || 'SSE error');
        }
      });

      state.source.onerror = () => {
        setConnection('reconnecting');
      };

      window.addEventListener('beforeunload', () => {
        state.source?.close();
      });
    }

    renderTabs();
    refreshAll();
    connectEvents();
  </script>
</body>
</html>`;
}
