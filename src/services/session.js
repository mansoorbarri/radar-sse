const { convex } = require("../db");
const { MAX_ROUTE_COORDS, MAX_RETRIES, RETRY_INTERVAL_MS } = require("../config");
const { flightSessions, disconnectedSessions } = require("../store");
const { downsampleRoute } = require("../utils/route");
const { createLogger } = require("../utils/logger");

const log = createLogger("session");

function getSystemSecretArgs() {
  return process.env.CONVEX_SYSTEM_SECRET
    ? { systemSecret: process.env.CONVEX_SYSTEM_SECRET }
    : {};
}

function getSessionEndTime(session, fallbackTime = Date.now()) {
  const endTime = Math.max(
    Number(session?.endTime) || 0,
    Number(session?.lastCoordAt) || 0,
  );
  return endTime > 0 ? endTime : fallbackTime;
}

function getSessionDurationMs(session, endTime) {
  const startTime =
    session?.startTime instanceof Date
      ? session.startTime.getTime()
      : new Date(session?.startTime).getTime();
  const pausedDurationMs = Math.max(0, Number(session?.pausedDurationMs) || 0);
  return Math.max(0, endTime - startTime - pausedDurationMs);
}

async function finalizeFlight(id, isRetry = false) {
  const session = flightSessions.get(id);
  if (!session) return { success: false, reason: "no_session" };

  // Initialize retry count if not set
  if (session.retryCount === undefined) {
    session.retryCount = 0;
  }

  try {
    if (session.coords.length > 2) {
      const endTime = getSessionEndTime(session);
      const duration = getSessionDurationMs(session, endTime);
      if (!session.endTime) session.endTime = endTime; // Preserve original end time for retries
      const routeData = downsampleRoute(session.coords, MAX_ROUTE_COORDS);
      if (session.coords.length > MAX_ROUTE_COORDS) {
        log.info("Downsampled route before saving active flight", {
          aircraftId: id,
          flightNo: session.flightNo,
          originalPoints: session.coords.length,
          downsampledPoints: routeData.length,
          maxRouteCoords: MAX_ROUTE_COORDS,
        });
      }
      await convex.mutation("flights:create", {
        userId: session.convexUserId,
        callsign: session.flightNo,
        aircraftType: session.aircraftType,
        depICAO: session.departure,
        arrICAO: session.arrival,
        squawk: session.squawk || undefined,
        duration,
        maxAltitude: session.maxAltitude || undefined,
        maxSpeed: session.maxSpeed || undefined,
        statsExcludedReason: session.statsExcludedReason || undefined,
        routeData: routeData,
        startTime: session.startTime.getTime(),
        endTime: endTime,
        ...getSystemSecretArgs(),
      });
      log.info(isRetry ? "Saved active flight after retry" : "Saved active flight", {
        aircraftId: id,
        flightNo: session.flightNo,
        convexUserId: session.convexUserId,
        retryCount: session.retryCount,
        routePoints: session.coords.length,
      });
    } else {
      log.warn("Skipping active flight save because route has insufficient coordinates", {
        aircraftId: id,
        flightNo: session.flightNo,
        convexUserId: session.convexUserId,
        routePoints: session.coords.length,
        minimumRoutePoints: 3,
      });
    }
    flightSessions.delete(id);
    return { success: true };
  } catch (e) {
    session.retryCount++;
    session.failedAt = Date.now();
    session.lastError = e.message;

    if (session.retryCount < MAX_RETRIES) {
      log.error("Failed to save active flight; scheduling retry", {
        aircraftId: id,
        flightNo: session.flightNo,
        convexUserId: session.convexUserId,
        attempt: session.retryCount,
        maxRetries: MAX_RETRIES,
        retryInMs: RETRY_INTERVAL_MS,
        error: e,
      });
      setTimeout(() => finalizeFlight(id, true), RETRY_INTERVAL_MS);
    } else {
      log.error("Failed to save active flight; automatic retries exhausted", {
        aircraftId: id,
        flightNo: session.flightNo,
        convexUserId: session.convexUserId,
        attempt: session.retryCount,
        maxRetries: MAX_RETRIES,
        failedAt: session.failedAt,
        error: e,
      });
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
    log.info("Grace period expired; finalizing disconnected flight", {
      convexUserId,
      originalAircraftId: data.originalId,
      flightNo: session.flightNo,
      disconnectedAt: data.disconnectedAt,
    });
  }

  try {
    if (session.coords.length > 2) {
      const endTime = Math.max(
        Number(data.endTime) || 0,
        Number(data.disconnectedAt) || 0,
        getSessionEndTime(session, Date.now()),
      );
      const duration = getSessionDurationMs(session, endTime);
      if (!data.endTime) data.endTime = endTime; // Preserve original end time for retries
      const routeData = downsampleRoute(session.coords, MAX_ROUTE_COORDS);
      if (session.coords.length > MAX_ROUTE_COORDS) {
        log.info("Downsampled route before saving disconnected flight", {
          convexUserId,
          originalAircraftId: data.originalId,
          flightNo: session.flightNo,
          originalPoints: session.coords.length,
          downsampledPoints: routeData.length,
          maxRouteCoords: MAX_ROUTE_COORDS,
        });
      }
      await convex.mutation("flights:create", {
        userId: session.convexUserId,
        callsign: session.flightNo,
        aircraftType: session.aircraftType,
        depICAO: session.departure,
        arrICAO: session.arrival,
        squawk: session.squawk || undefined,
        duration,
        maxAltitude: session.maxAltitude || undefined,
        maxSpeed: session.maxSpeed || undefined,
        statsExcludedReason: session.statsExcludedReason || undefined,
        routeData: routeData,
        startTime: session.startTime.getTime(),
        endTime: endTime,
        ...getSystemSecretArgs(),
      });
      log.info(isRetry ? "Saved disconnected flight after retry" : "Saved disconnected flight", {
        convexUserId,
        originalAircraftId: data.originalId,
        flightNo: session.flightNo,
        retryCount: data.retryCount,
        routePoints: session.coords.length,
      });
    } else {
      log.warn("Skipping disconnected flight save because route has insufficient coordinates", {
        convexUserId,
        originalAircraftId: data.originalId,
        flightNo: session.flightNo,
        routePoints: session.coords.length,
        minimumRoutePoints: 3,
      });
    }
    disconnectedSessions.delete(convexUserId);
    return { success: true };
  } catch (e) {
    data.retryCount++;
    data.failedAt = Date.now();
    data.lastError = e.message;

    if (data.retryCount < MAX_RETRIES) {
      log.error("Failed to save disconnected flight; scheduling retry", {
        convexUserId,
        originalAircraftId: data.originalId,
        flightNo: session.flightNo,
        attempt: data.retryCount,
        maxRetries: MAX_RETRIES,
        retryInMs: RETRY_INTERVAL_MS,
        error: e,
      });
      setTimeout(() => finalizeDisconnectedSession(convexUserId, true), RETRY_INTERVAL_MS);
    } else {
      log.error("Failed to save disconnected flight; automatic retries exhausted", {
        convexUserId,
        originalAircraftId: data.originalId,
        flightNo: session.flightNo,
        attempt: data.retryCount,
        maxRetries: MAX_RETRIES,
        failedAt: data.failedAt,
        error: e,
      });
    }
    return { success: false, reason: "save_failed", error: e.message, retryCount: data.retryCount };
  }
}

module.exports = {
  finalizeFlight,
  finalizeDisconnectedSession,
};
