'use strict';

const { redisLabel } = require('./config');
const { normalizeCounts, parseRange } = require('./http-utils');

function registerRoutes({
  app,
  config,
  connection,
  jobStatuses,
  queue,
  renderLivePage,
  serializers,
  sseHub,
}) {
  app.get('/', (req, res) => {
    res.redirect(config.livePath);
  });

  app.get('/health', async (req, res) => {
    try {
      const pong = await connection.ping();
      res.json({
        ok: pong === 'PONG',
        redis: redisLabel(config),
        queue: config.queueName,
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        error: error.message,
        redis: redisLabel(config),
        queue: config.queueName,
      });
    }
  });

  app.get('/api/queue/summary', async (req, res) => {
    try {
      const [counts, isPaused, workersCount] = await Promise.all([
        queue.getJobCounts(...jobStatuses),
        queue.isPaused(),
        queue.getWorkersCount().catch(() => null),
      ]);
      const normalizedCounts = normalizeCounts(jobStatuses, counts);

      res.json({
        queue: config.queueName,
        redis: redisLabel(config),
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
        redis: redisLabel(config),
      });
    }
  });

  app.get('/api/jobs', async (req, res) => {
    const status = req.query.status || 'waiting';

    if (!jobStatuses.includes(status)) {
      res.status(400).json({
        error: `Unknown status "${status}"`,
        allowedStatuses: jobStatuses,
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
        jobs: await Promise.all(jobs.map(job => serializers.serializeJobSummary(job, status))),
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

      res.json(await serializers.serializeJob(job));
    } catch (error) {
      res.status(503).json({
        error: error.message,
        id: req.params.id,
      });
    }
  });

  app.get(`${config.livePath}/events`, sseHub.handleRequest);

  app.get(config.livePath, (req, res) => {
    res.type('html').send(renderLivePage(config, jobStatuses));
  });
}

module.exports = {
  registerRoutes,
};
