const { GRACE_PERIOD_MS } = require("../config");
const { aircraftMap, flightSessions, disconnectedSessions, commandQueue } = require("../store");
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
      if (now - (aircraft.ts || 0) > 30000) {
        const session = flightSessions.get(id);
        if (session) {
          log.info("Aircraft disconnected; moving flight session to disconnected pool", {
            aircraftId: id,
            flightNo: session.flightNo,
            convexUserId: session.convexUserId,
            lastSeenAt: aircraft.ts || null,
            ageMs: now - (aircraft.ts || 0),
            resumableWindowMs: GRACE_PERIOD_MS,
          });
          // Move to disconnected sessions instead of finalizing.
          disconnectedSessions.set(session.convexUserId, {
            session,
            originalId: id,
            disconnectedAt: now,
            resumeApprovedForId: null,
            resumeApprovedAt: null,
          });
          flightSessions.delete(id);
        } else {
          log.info("Aircraft timed out with no active flight session", {
            aircraftId: id,
            lastSeenAt: aircraft.ts || null,
            ageMs: now - (aircraft.ts || 0),
          });
        }
        markAircraftRemoved(id);
        aircraftMap.delete(id);
        commandQueue.delete(id); // Clean up stale commands
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
