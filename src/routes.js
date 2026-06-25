'use strict';

const path = require('path');
const express = require('express');

function registerRoutes({ app, config, monitor, publicDir }) {
  app.use(`${config.livePath}/assets`, express.static(publicDir));

  app.get('/', (req, res) => {
    res.redirect(config.livePath);
  });

  app.get('/health', async (req, res) => {
    try {
      res.json(await monitor.getHealth());
    } catch (error) {
      res.status(503).json({
        ok: false,
        error: error.message,
        queue: config.queueName,
      });
    }
  });

  app.get('/api/queue/summary', async (req, res) => {
    try {
      res.json(await monitor.getSummary());
    } catch (error) {
      res.status(503).json({
        ok: false,
        error: error.message,
        queue: config.queueName,
      });
    }
  });

  app.get('/api/jobs', async (req, res) => {
    try {
      res.json(await monitor.getJobs(req.query));
    } catch (error) {
      res.status(error.statusCode || 503).json({
        error: error.message,
        allowedStatuses: error.allowedStatuses,
      });
    }
  });

  app.get('/api/jobs/:id', async (req, res) => {
    try {
      res.json(await monitor.getJob(req.params.id));
    } catch (error) {
      res.status(error.statusCode || 503).json({
        error: error.message,
        id: req.params.id,
      });
    }
  });

  app.get(`${config.livePath}/events`, monitor.events.handleRequest);

  app.get(config.livePath, (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

module.exports = {
  registerRoutes,
};
