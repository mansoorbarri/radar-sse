const { AIRCRAFT_STALE_TIMEOUT_MS, GRACE_PERIOD_MS } = require("../config");
const {
  aircraftMap,
  flightSessions,
  disconnectedSessions,
  commandQueue,
  clearFlightIdentity,
  parkDisconnectedSession,
} = require("../store");
const { finalizeDisconnectedSession } = require("../services/session");
const { broadcast, markAircraftRemoved } = require("../services/broadcast");
const { createLogger } = require("../utils/logger");

const log = createLogger("cleanup");

// Check for aircraft that stopped sending updates.
// Moves flight sessions into the disconnected pool instead of finalizing immediately.
function startTimeoutCheck() {
  setInterval(() => {
    const now = Date.now();
    let hasRemovals = false;

    for (const [id, aircraft] of aircraftMap.entries()) {
      if (now - (aircraft.ts || 0) > AIRCRAFT_STALE_TIMEOUT_MS) {
        const session = flightSessions.get(id);
        if (session) {
          log.info("Aircraft disconnected; moving flight session to disconnected pool", {
            aircraftId: id,
            flightNo: session.flightNo,
            convexUserId: session.convexUserId,
            lastSeenAt: aircraft.ts || null,
            ageMs: now - (aircraft.ts || 0),
            staleTimeoutMs: AIRCRAFT_STALE_TIMEOUT_MS,
            resumableWindowMs: GRACE_PERIOD_MS,
          });
          // Move to disconnected sessions instead of finalizing.
          parkDisconnectedSession(session, id, aircraft.ts || now);
          flightSessions.delete(id);
        } else {
          log.info("Aircraft timed out with no active flight session", {
            aircraftId: id,
            lastSeenAt: aircraft.ts || null,
            ageMs: now - (aircraft.ts || 0),
            staleTimeoutMs: AIRCRAFT_STALE_TIMEOUT_MS,
          });
        }
        markAircraftRemoved(id);
        aircraftMap.delete(id);
        commandQueue.delete(id); // Clean up stale commands
        clearFlightIdentity(id);
        hasRemovals = true;
      }
    }

    // Batch broadcast for all removals
    if (hasRemovals) {
      broadcast();
    }
  }, 5000);
}

// Check for disconnected sessions that have exceeded the resumable window.
function startGracePeriodCheck() {
  setInterval(() => {
    const now = Date.now();
    for (const [convexUserId, data] of disconnectedSessions.entries()) {
      if (now - data.disconnectedAt > GRACE_PERIOD_MS) {
        finalizeDisconnectedSession(convexUserId);
      }
    }
  }, 30000); // Check every 30 seconds
}

function startAllTasks() {
  startTimeoutCheck();
  startGracePeriodCheck();
}

module.exports = {
  startAllTasks,
  startTimeoutCheck,
  startGracePeriodCheck,
};
