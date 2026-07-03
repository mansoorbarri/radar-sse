// How long to keep an unexpectedly disconnected flight resumable.
const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

// Maximum coordinates to store (Convex array limit is 8192)
const MAX_ROUTE_COORDS = 8000;

// Maximum coordinates to keep in memory during flight (downsample when exceeded)
const MAX_MEMORY_COORDS = 2000;

// Retry settings for failed flight saves
const MAX_RETRIES = 3;
const RETRY_INTERVAL_MS = 30000; // 30 seconds

// Maximum SSE broadcast frequency. Higher values reduce network egress.
const BROADCAST_INTERVAL_MS = Number(process.env.BROADCAST_INTERVAL_MS) || 1000;

// How often to checkpoint in-memory flight sessions to Convex.
const FLIGHT_SESSION_PERSIST_INTERVAL_MS =
  Number(process.env.FLIGHT_SESSION_PERSIST_INTERVAL_MS) || 30000;

module.exports = {
  GRACE_PERIOD_MS,
  MAX_ROUTE_COORDS,
  MAX_MEMORY_COORDS,
  MAX_RETRIES,
  RETRY_INTERVAL_MS,
  BROADCAST_INTERVAL_MS,
  FLIGHT_SESSION_PERSIST_INTERVAL_MS,
};
