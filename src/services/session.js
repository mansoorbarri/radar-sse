const { convex } = require("../db");
const { MAX_ROUTE_COORDS, MAX_RETRIES, RETRY_INTERVAL_MS } = require("../config");
const { flightSessions, disconnectedSessions } = require("../store");
const { downsampleRoute } = require("../utils/route");

async function finalizeFlight(id, isRetry = false) {
  const session = flightSessions.get(id);
  if (!session) return { success: false, reason: "no_session" };

  // Initialize retry count if not set
  if (session.retryCount === undefined) {
    session.retryCount = 0;
  }

  try {
    if (session.coords.length > 2) {
      const endTime = session.endTime || Date.now();
      if (!session.endTime) session.endTime = endTime; // Preserve original end time for retries
      const routeData = downsampleRoute(session.coords, MAX_ROUTE_COORDS);
      if (session.coords.length > MAX_ROUTE_COORDS) {
        console.log(`[FINALIZE] Downsampled route from ${session.coords.length} to ${routeData.length} points`);
      }
      await convex.mutation("flights:create", {
        userId: session.convexUserId,
        callsign: session.flightNo,
        aircraftType: session.aircraftType,
        depICAO: session.departure,
        arrICAO: session.arrival,
        squawk: session.squawk || undefined,
        duration: endTime - session.startTime.getTime(),
        maxAltitude: session.maxAltitude || undefined,
        maxSpeed: session.maxSpeed || undefined,
        routeData: routeData,
        startTime: session.startTime.getTime(),
        endTime: endTime,
      });
    }
    if (isRetry) {
      console.log(`[RETRY] Successfully saved flight ${session.flightNo} on retry ${session.retryCount}`);
    }
    flightSessions.delete(id);
    return { success: true };
  } catch (e) {
    session.retryCount++;
    session.failedAt = Date.now();
    session.lastError = e.message;

    if (session.retryCount < MAX_RETRIES) {
      console.error(`[FINALIZE] Failed to save flight ${session.flightNo} (attempt ${session.retryCount}/${MAX_RETRIES}), will retry in ${RETRY_INTERVAL_MS / 1000}s:`, e.message);
      setTimeout(() => finalizeFlight(id, true), RETRY_INTERVAL_MS);
    } else {
      console.error(`[FINALIZE] Failed to save flight ${session.flightNo} after ${MAX_RETRIES} attempts, keeping for manual retry:`, e.message);
    }
    return { success: false, reason: "save_failed", error: e.message, retryCount: session.retryCount };
  }
}

// Finalize a disconnected session after grace period expires
async function finalizeDisconnectedSession(convexUserId, isRetry = false) {
  const data = disconnectedSessions.get(convexUserId);
  if (!data) return { success: false, reason: "no_session" };

  const { session } = data;

  // Initialize retry count if not set
  if (data.retryCount === undefined) {
    data.retryCount = 0;
  }

  if (!isRetry) {
    console.log(`[FINALIZE] Grace period expired for user ${convexUserId}, saving flight`);
  }

  try {
    if (session.coords.length > 2) {
      const endTime = data.endTime || Date.now();
      if (!data.endTime) data.endTime = endTime; // Preserve original end time for retries
      const routeData = downsampleRoute(session.coords, MAX_ROUTE_COORDS);
      if (session.coords.length > MAX_ROUTE_COORDS) {
        console.log(`[FINALIZE] Downsampled route from ${session.coords.length} to ${routeData.length} points`);
      }
      await convex.mutation("flights:create", {
        userId: session.convexUserId,
        callsign: session.flightNo,
        aircraftType: session.aircraftType,
        depICAO: session.departure,
        arrICAO: session.arrival,
        squawk: session.squawk || undefined,
        duration: endTime - session.startTime.getTime(),
        maxAltitude: session.maxAltitude || undefined,
        maxSpeed: session.maxSpeed || undefined,
        routeData: routeData,
        startTime: session.startTime.getTime(),
        endTime: endTime,
      });
      if (isRetry) {
        console.log(`[RETRY] Successfully saved flight ${session.flightNo} on retry ${data.retryCount}`);
      } else {
        console.log(`[FINALIZE] Flight saved for ${session.flightNo}`);
      }
    }
    disconnectedSessions.delete(convexUserId);
    return { success: true };
  } catch (e) {
    data.retryCount++;
    data.failedAt = Date.now();
    data.lastError = e.message;

    if (data.retryCount < MAX_RETRIES) {
      console.error(`[FINALIZE] Failed to save flight ${session.flightNo} (attempt ${data.retryCount}/${MAX_RETRIES}), will retry in ${RETRY_INTERVAL_MS / 1000}s:`, e.message);
      setTimeout(() => finalizeDisconnectedSession(convexUserId, true), RETRY_INTERVAL_MS);
    } else {
      console.error(`[FINALIZE] Failed to save flight ${session.flightNo} after ${MAX_RETRIES} attempts, keeping for manual retry:`, e.message);
    }
    return { success: false, reason: "save_failed", error: e.message, retryCount: data.retryCount };
  }
}

module.exports = {
  finalizeFlight,
  finalizeDisconnectedSession,
};
