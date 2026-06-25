const JOB_STATUSES = ['waiting', 'active', 'delayed', 'prioritized', 'completed', 'failed', 'waiting-children'];
const LIVE_PATH = window.location.pathname.replace(/\/$/, '') || '/live';
const state = {
  status: 'waiting',
  selectedJobId: null,
  refreshTimer: null,
  isRefreshing: false,
  pendingRefresh: false,
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

document.getElementById('refreshButton').addEventListener('click', () => queueRefresh());

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
      queueRefresh();
    });
    tabsEl.appendChild(button);
  }
}

function renderSummary(summary) {
  queueNameEl.textContent = summary.queue;
  redisNameEl.textContent = summary.redis;
  document.getElementById('bullBoardLink').href = summary.bullBoardPath;
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
    row.children[2].textContent = job.attemptsMade + ' / ' + job.attemptsStarted;
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
  if (state.isRefreshing) {
    state.pendingRefresh = true;
    return;
  }

  state.isRefreshing = true;

  try {
    showError('');
    await Promise.all([refreshSummary(), refreshJobs()]);
    if (state.selectedJobId) {
      await loadDetail(state.selectedJobId, true);
    }
  } catch (error) {
    showError(error.message);
  } finally {
    state.isRefreshing = false;

    if (state.pendingRefresh) {
      state.pendingRefresh = false;
      scheduleRefresh(500);
    }
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

function scheduleRefresh(delay = 250) {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => queueRefresh(), delay);
}

function queueRefresh() {
  if (state.isRefreshing) {
    state.pendingRefresh = true;
    return;
  }

  refreshAll();
}

function connectEvents() {
  setConnection('reconnecting');
  state.source = new EventSource(LIVE_PATH + '/events');

  state.source.addEventListener('connected', event => {
    setConnection('connected');
    lastEventEl.textContent = JSON.parse(event.data).event;
    queueRefresh();
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
queueRefresh();
connectEvents();