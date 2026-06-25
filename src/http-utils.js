'use strict';

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

function normalizeCounts(statuses, counts) {
  return Object.fromEntries(statuses.map(status => [status, counts[status] || 0]));
}

module.exports = {
  normalizeCounts,
  parseRange,
};
