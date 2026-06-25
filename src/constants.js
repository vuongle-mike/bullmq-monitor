'use strict';

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

module.exports = {
  JOB_STATUSES,
  QUEUE_EVENT_NAMES,
};
