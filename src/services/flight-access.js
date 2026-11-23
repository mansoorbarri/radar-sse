const { convex } = require("../db");
const { createLogger } = require("../utils/logger");

const log = createLogger("flight-access");

// Free pilots can only start a flight while an admin has an event live; Pro
// pilots always can. RadarThing decides this in Convex. The server checks it
// here too, so old userscripts (which never ask) and hand-made requests can't
// start a flight the website would refuse.

// An admin turning the event off or on should take effect within this long.
const ACCESS_CACHE_TTL_MS = 15 * 1000;
// A slow Convex call must not hold the first position forever.
const ACCESS_CHECK_TIMEOUT_MS = 4000;

const DENIED_MESSAGE =
  "No event is live right now, and starting a flight outside an event needs RadarThing Pro.";

// googleId ("" for signed-out pilots) -> { allowed, checkedAt } or { promise }
const accessCache = new Map();

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function queryAccess(googleId) {
  try {
    const access = await withTimeout(
      convex.query("siteSettings:getFlightStartAccess", {
        googleId: googleId || undefined,
      }),
      ACCESS_CHECK_TIMEOUT_MS,
    );
    const allowed = access?.allowed !== false;
    accessCache.set(googleId, { allowed, checkedAt: Date.now() });
    if (!allowed) {
      // Logged once per cache period, not on every rejected position.
      log.info("Refused to start a flight: no event live and no Pro access", {
        googleId: googleId || null,
        eventLive: access?.eventLive,
      });
    }
    return allowed;
  } catch (error) {
    // Fail open, like the userscript: a Convex outage shouldn't ground every
    // pilot. Don't cache it, so the next new flight checks again.
    accessCache.delete(googleId);
    log.error("Flight start access check failed; allowing the flight", {
      googleId: googleId || null,
      error,
    });
    return true;
  }
}

// Resolves to true when this pilot may start a new flight right now.
function canStartFlight(googleId) {
  const key = googleId ? String(googleId) : "";
  const cached = accessCache.get(key);
  if (cached?.promise) return cached.promise;
  if (cached && Date.now() - cached.checkedAt < ACCESS_CACHE_TTL_MS) {
    return Promise.resolve(cached.allowed);
  }
  // Share one Convex call between position updates that arrive together.
  const promise = queryAccess(key);
  accessCache.set(key, { promise });
  return promise;
}

// Drop expired entries so pilots who were checked once don't pile up.
function pruneFlightAccessCache(now = Date.now()) {
  for (const [key, entry] of accessCache) {
    if (!entry.promise && now - entry.checkedAt >= ACCESS_CACHE_TTL_MS) {
      accessCache.delete(key);
    }
  }
}

module.exports = {
  DENIED_MESSAGE,
  canStartFlight,
  pruneFlightAccessCache,
};
