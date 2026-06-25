'use strict';

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

function createJobSerializers(queue) {
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

  function serializeJobSummaryFromHash(jobId, fields, status) {
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

  return {
    serializeJob,
    serializeJobSummaryFromHash,
    serializeJobSummary,
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

module.exports = {
  createJobSerializers,
  toPlainValue,
};
