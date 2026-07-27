const express = require("express");
const { convex } = require("../db");
const { MAX_MEMORY_COORDS } = require("../config");
const {
  aircraftMap,
  flightSessions,
  disconnectedSessions,
  getCachedUser,
  setCachedUser,
  getFlightIdentity,
  setFlightIdentity,
  clearFlightIdentity,
} = require("../store");
const { broadcast, markAircraftChanged } = require("../services/broadcast");
const { downsampleRoute } = require("../utils/route");
const {
  normalizeSessionField,
  normalizeSessionTimestamp,
  getSessionFlightIdentifier,
  getSessionDeparture,
  getSessionArrival,
} = require("../utils/session-match");
const {
  buildAircraftDisplayFields,
  buildAuthLogIdentity,
} = require("../utils/display");
const { createLogger } = require("../utils/logger");

const router = express.Router();
const log = createLogger("position");
const DEFAULT_STATS_MAX_SPEED_KTS = 750;
const HIGH_PERFORMANCE_STATS_MAX_SPEED_KTS = 1100;
const STATS_EXCLUDED_SPEED_REASON = "speed_over_stats_limit";
const EARTH_RADIUS_NM = 3440.065;
const MIN_SPEED_SAMPLE_INTERVAL_MS = 1000;
const MAX_REASONABLE_REPORTED_SPEED_KTS = 3000;
const MAX_REASONABLE_OBSERVED_SPEED_KTS = 3000;
const MAX_SHORT_INTERVAL_JUMP_NM = 1;
const AUTO_RESUME_FALLBACK_WINDOW_MS = 15 * 60 * 1000;

function isHighPerformanceStatsAircraft(aircraftType) {
  const normalized = String(aircraftType || "").trim().toUpperCase();
  if (!normalized) return false;

  if (normalized.includes("CONCORDE")) return true;

  return (
    /\bF\/?A-?\d{1,3}[A-Z]?\b/.test(normalized) ||
    /\bF-?\d{1,3}[A-Z]?\b/.test(normalized) ||
    /\b[ABT]-\d{1,3}[A-Z]?\b/.test(normalized) ||
    /\bSR-?71\b/.test(normalized) ||
    /\bYF-?\d{1,3}[A-Z]?\b/.test(normalized) ||
    /\bMIG-?\d{1,3}[A-Z]?\b/.test(normalized) ||
    /\bSU-?\d{1,3}[A-Z]?\b/.test(normalized) ||
    /\bJAS-?\d{1,3}[A-Z]?\b/.test(normalized) ||
    /\bEUROFIGHTER\b/.test(normalized) ||
    /\bTYPHOON\b/.test(normalized) ||
    /\bRAFALE\b/.test(normalized) ||
    /\bMIRAGE\b/.test(normalized) ||
    /\bGRIPEN\b/.test(normalized) ||
    /\bTORNADO\b/.test(normalized) ||
    /\bHARRIER\b/.test(normalized) ||
    /\bPHANTOM\b/.test(normalized) ||
    /\bVIGGEN\b/.test(normalized) ||
    /\bSUKHOI\b/.test(normalized) ||
    /\bMIKOYAN\b/.test(normalized)
  );
}

function getStatsMaxSpeedKts(aircraftType) {
  return isHighPerformanceStatsAircraft(aircraftType)
    ? HIGH_PERFORMANCE_STATS_MAX_SPEED_KTS
    : DEFAULT_STATS_MAX_SPEED_KTS;
}

function toRad(value) {
  return value * (Math.PI / 180);
}

function haversineDistanceNm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_NM * c;
}

function isValidCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function getReportedSpeedKts(data) {
  const indicatedSpeed = Number(data.speed);
  const groundSpeed = Number(data.groundSpeed);
  const speed = Number.isFinite(indicatedSpeed) ? indicatedSpeed : groundSpeed;

  if (
    !Number.isFinite(speed) ||
    speed < 0 ||
    speed > MAX_REASONABLE_REPORTED_SPEED_KTS
  ) {
    return undefined;
  }

  return speed;
}

function updateMaxSpeed(session, speedKts) {
  if (!Number.isFinite(speedKts) || speedKts < 0) return;

  session.maxSpeed = Math.max(session.maxSpeed || 0, speedKts);
  if (speedKts > getStatsMaxSpeedKts(session.aircraftType)) {
    session.statsExcludedReason = STATS_EXCLUDED_SPEED_REASON;
  }
}

function shouldAutoResumeSession(disconnected, data, receivedAt) {
  if (!disconnected?.session) return false;

  const session = disconnected.session;
  const sessionTakeoffTime = normalizeSessionTimestamp(session.takeoffTime);
  const incomingTakeoffTime = normalizeSessionTimestamp(data.takeoffTime);
  if (sessionTakeoffTime && incomingTakeoffTime) {
    return sessionTakeoffTime === incomingTakeoffTime;
  }

  if (
    typeof disconnected.disconnectedAt === "number" &&
    receivedAt - disconnected.disconnectedAt > AUTO_RESUME_FALLBACK_WINDOW_MS
  ) {
    return false;
  }

  const sessionFlightNo = normalizeSessionField(
    session.flightNo || session.callsign,
  );
  const incomingFlightNo = normalizeSessionField(data.flightNo || data.callsign);
  if (!sessionFlightNo || !incomingFlightNo || sessionFlightNo !== incomingFlightNo) {
    return false;
  }

  const sessionDeparture = getSessionDeparture(session);
  const incomingDeparture = getSessionDeparture(data);
  if (sessionDeparture && incomingDeparture && sessionDeparture !== incomingDeparture) {
    return false;
  }

  const sessionArrival = getSessionArrival(session);
  const incomingArrival = getSessionArrival(data);
  if (sessionArrival && incomingArrival && sessionArrival !== incomingArrival) {
    return false;
  }

  const hasMatchingRouteMetadata =
    Boolean(sessionDeparture && incomingDeparture) ||
    Boolean(sessionArrival && incomingArrival) ||
    Boolean(
      sessionDeparture &&
        incomingDeparture &&
        sessionArrival &&
        incomingArrival,
    );

  return hasMatchingRouteMetadata;
}

// Add coordinate to session with memory limit enforcement
function addCoordToSession(session, lat, lon) {
  const last = session.coords[session.coords.length - 1];
  if (!last) {
    session.coords.push([lat, lon]);
    return;
  }

  // Only add if moved enough
  if (Math.abs(last[0] - lat) > 0.0002 || Math.abs(last[1] - lon) > 0.0002) {
    session.coords.push([lat, lon]);

    // Downsample if exceeding memory limit
    if (session.coords.length > MAX_MEMORY_COORDS) {
      const originalPoints = session.coords.length;
      const targetSize = Math.floor(MAX_MEMORY_COORDS * 0.75); // Downsample to 75% to avoid frequent resampling
      session.coords = downsampleRoute(session.coords, targetSize);
      log.info("Downsampled in-memory route coordinates", {
        flightNo: session.flightNo,
        originalPoints,
        downsampledPoints: session.coords.length,
        maxMemoryCoords: MAX_MEMORY_COORDS,
        targetSize,
      });
    }
  }
}

function updateSessionPosition(session, data, receivedAt) {
  const lat = Number(data.lat);
  const lon = Number(data.lon);
  if (!isValidCoordinate(lat, lon)) return;

  const previousCoord =
    Array.isArray(session.lastCoord) && session.lastCoord.length >= 2
      ? session.lastCoord
      : session.coords[session.coords.length - 1];
  const previousAt =
    typeof session.lastCoordAt === "number" ? session.lastCoordAt : undefined;
  const reportedSpeedKts = getReportedSpeedKts(data);

  if (
    previousCoord &&
    isValidCoordinate(previousCoord[0], previousCoord[1]) &&
    previousAt !== undefined &&
    receivedAt > previousAt
  ) {
    const elapsedMs = receivedAt - previousAt;
    const distanceNm = haversineDistanceNm(
      previousCoord[0],
      previousCoord[1],
      lat,
      lon,
    );
    const elapsedHours = elapsedMs / 3600000;
    const observedSpeedKts = distanceNm / elapsedHours;
    const isShortIntervalJump =
      elapsedMs < MIN_SPEED_SAMPLE_INTERVAL_MS &&
      distanceNm > MAX_SHORT_INTERVAL_JUMP_NM;
    const isImplausibleObservedSpeed =
      elapsedMs >= MIN_SPEED_SAMPLE_INTERVAL_MS &&
      observedSpeedKts > MAX_REASONABLE_OBSERVED_SPEED_KTS;

    if (isShortIntervalJump || isImplausibleObservedSpeed) {
      session.rejectedPositionCount = (session.rejectedPositionCount || 0) + 1;
      if (session.rejectedPositionCount === 1) {
        log.warn("Rejected implausible flight recording position", {
          flightNo: session.flightNo,
          aircraftType: session.aircraftType,
          elapsedMs,
          distanceNm: Math.round(distanceNm * 10) / 10,
          observedSpeedKts: Math.round(observedSpeedKts),
          reportedSpeedKts,
          rejectedPositionCount: session.rejectedPositionCount,
        });
      }
      return;
    }

    if (reportedSpeedKts !== undefined) {
      updateMaxSpeed(session, reportedSpeedKts);
    } else if (
      elapsedMs >= MIN_SPEED_SAMPLE_INTERVAL_MS &&
      observedSpeedKts <= MAX_REASONABLE_OBSERVED_SPEED_KTS
    ) {
      updateMaxSpeed(session, observedSpeedKts);
    }
  } else if (reportedSpeedKts !== undefined) {
    updateMaxSpeed(session, reportedSpeedKts);
  }

  addCoordToSession(session, lat, lon);
  session.lastCoord = [lat, lon];
  session.lastCoordAt = receivedAt;
  session.endTime = receivedAt;
}

function updateSessionMetadata(session, data) {
  session.callsign = data.callsign || session.callsign || "Unknown";
  session.flightNo = data.flightNo || session.flightNo || "Unknown";
  session.aircraftType = data.type || session.aircraftType || "Unknown";
  session.departure = data.departure || session.departure || "???";
  session.arrival = data.arrival || session.arrival || "???";
  session.af = data.af || session.af || "";
  session.nextWaypoint = data.nextWaypoint || session.nextWaypoint || null;
  session.takeoffTime = data.takeoffTime || session.takeoffTime || "";

  if (data.squawk) {
    session.squawk = data.squawk;
  }

  if (data.altMSL && data.altMSL > session.maxAltitude) {
    session.maxAltitude = data.altMSL;
  }
}

function createFlightSession(data, receivedAt, convexUserId = null) {
  const lat = Number(data.lat);
  const lon = Number(data.lon);
  const initialSpeedKts = getReportedSpeedKts(data) || 0;
  return {
    convexUserId,
    googleId: data.googleId ? String(data.googleId) : null,
    callsign: data.callsign || "Unknown",
    flightNo: data.flightNo || "Unknown",
    aircraftType: data.type || "Unknown",
    departure: data.departure || "???",
    arrival: data.arrival || "???",
    squawk: data.squawk || null,
    af: data.af || "",
    nextWaypoint: data.nextWaypoint || null,
    takeoffTime: data.takeoffTime || "",
    maxAltitude: data.altMSL || 0,
    maxSpeed: initialSpeedKts,
    statsExcludedReason:
      initialSpeedKts > getStatsMaxSpeedKts(data.type)
        ? STATS_EXCLUDED_SPEED_REASON
        : undefined,
    coords: isValidCoordinate(lat, lon) ? [[lat, lon]] : [],
    lastCoord: isValidCoordinate(lat, lon) ? [lat, lon] : null,
    lastCoordAt: receivedAt,
    endTime: receivedAt,
    pausedDurationMs: 0,
    startTime: new Date(),
  };
}

function mergePendingSession(restored, pending) {
  for (const coord of pending.coords || []) {
    const last = restored.coords[restored.coords.length - 1];
    if (!last || Math.abs(last[0] - coord[0]) > 0.0002 || Math.abs(last[1] - coord[1]) > 0.0002) {
      restored.coords.push(coord);
    }
  }
  restored.lastCoord = pending.lastCoord || restored.lastCoord;
  restored.lastCoordAt = Math.max(
    Number(restored.lastCoordAt) || 0,
    Number(pending.lastCoordAt) || 0,
  );
  restored.endTime = Math.max(
    Number(restored.endTime) || 0,
    Number(pending.endTime) || 0,
  );
  restored.maxAltitude = Math.max(
    Number(restored.maxAltitude) || 0,
    Number(pending.maxAltitude) || 0,
  );
  restored.maxSpeed = Math.max(
    Number(restored.maxSpeed) || 0,
    Number(pending.maxSpeed) || 0,
  );
}

function resolveFlightIdentity(aircraftId, googleId) {
  const searchId = String(googleId);
  const cachedUser = getCachedUser(searchId);
  if (cachedUser) {
    setFlightIdentity(aircraftId, { googleId: searchId, ...cachedUser });
    return;
  }

  // Identity enrichment must never delay the real-time position response.
  // Keep the promise in the per-flight cache so repeated position updates do
  // not start duplicate Convex requests while the first lookup is pending.
  setFlightIdentity(aircraftId, { googleId: searchId, pending: true });
  void convex
    .query("users:getByGoogleId", { googleId: searchId })
    .then((user) => {
      const identity = {
        user,
        role: user?.role || "FREE",
        convexUserId: user?._id || null,
      };
      setCachedUser(searchId, user);
      const current = getFlightIdentity(aircraftId, searchId);
      if (current?.pending) {
        setFlightIdentity(aircraftId, { googleId: searchId, ...identity });
      }

      const authIdentity = buildAuthLogIdentity({
        aircraft: { id: aircraftId },
        user,
        googleId: searchId,
      });
      log.info(
        user
          ? "Resolved authenticated user for flight identity"
          : "No user found for flight identity; defaulting to FREE role",
        {
          aircraftId,
          googleId: searchId,
          convexUserId: identity.convexUserId,
          role: identity.role,
          identity: authIdentity,
        },
      );
    })
    .catch((error) => {
      const current = getFlightIdentity(aircraftId, searchId);
      if (current?.pending) {
        clearFlightIdentity(aircraftId);
      }
      log.error("Failed to resolve flight identity; will retry on the next position update", {
        aircraftId,
        googleId: searchId,
        error,
      });
    });
}

router.post("/", async (req, res) => {
  const data = req.body;
  if (data.id) {
    const receivedAt = Date.now();
    let role = "FREE"; // Default to FREE
    const airlineLogo = null;
    let convexUserId = null;
    let user = null;

    if (data.googleId) {
      const searchId = String(data.googleId);
      let identity = getFlightIdentity(data.id, searchId);
      if (!identity) {
        resolveFlightIdentity(data.id, searchId);
        identity = getFlightIdentity(data.id, searchId);
      }
      if (!identity?.pending) {
        user = identity?.user || null;
        role = identity?.role || "FREE";
        convexUserId = identity?.convexUserId || null;
      }
    }

    const displayFields = buildAircraftDisplayFields({
      aircraft: data,
      user,
    });

    // Track every signed-in flight immediately. Identity enrichment can finish
    // later without losing the first position, start time, or speed samples.
    if (data.googleId) {
      // Restore a disconnected session when the pilot explicitly claims it or
      // when the continued leg is clearly the same flight. This requires a
      // resolved Convex user ID; pending sessions are reconciled below.
      if (!flightSessions.has(data.id) && convexUserId && disconnectedSessions.has(convexUserId)) {
        const disconnected = disconnectedSessions.get(convexUserId);
        const { session, originalId, resumeApprovedForId } = disconnected;
        const autoResume = shouldAutoResumeSession(
          disconnected,
          data,
          receivedAt,
        );

        if (
          (typeof resumeApprovedForId === "string" &&
            resumeApprovedForId === data.id) ||
          autoResume
        ) {
          log.info("Restoring disconnected flight session", {
            flightNo: session.flightNo,
            convexUserId,
            previousAircraftId: originalId,
            currentAircraftId: data.id,
            disconnectedSessions: disconnectedSessions.size,
            restoredBy:
              typeof resumeApprovedForId === "string" &&
              resumeApprovedForId === data.id
                ? "explicit_resume"
                : "same_flight_auto_resume",
          });

          const pausedGapMs = Math.max(
            0,
            receivedAt - (Number(disconnected.disconnectedAt) || receivedAt),
          );
          session.pausedDurationMs =
            (Number(session.pausedDurationMs) || 0) + pausedGapMs;
          flightSessions.set(data.id, session);
          disconnectedSessions.delete(convexUserId);

          updateSessionPosition(session, data, receivedAt);
          updateSessionMetadata(session, data);
        } else {
          log.warn("Starting a new active flight session while a disconnected session exists", {
            aircraftId: data.id,
            currentFlightNo: getSessionFlightIdentifier(data),
            disconnectedFlightNo: getSessionFlightIdentifier(session),
            currentDeparture: getSessionDeparture(data),
            disconnectedDeparture: getSessionDeparture(session),
            currentArrival: getSessionArrival(data),
            disconnectedArrival: getSessionArrival(session),
            currentTakeoffTime: normalizeSessionTimestamp(data.takeoffTime),
            disconnectedTakeoffTime: normalizeSessionTimestamp(session.takeoffTime),
            convexUserId,
          });
          flightSessions.set(data.id, createFlightSession(data, receivedAt, convexUserId));
        }
      } else if (!flightSessions.has(data.id)) {
        flightSessions.set(data.id, createFlightSession(data, receivedAt, convexUserId));
      } else {
        // Existing active session - add coordinates and update max values
        const session = flightSessions.get(data.id);
        if (convexUserId && !session.convexUserId) {
          const disconnected = disconnectedSessions.get(convexUserId);
          const isApprovedResume =
            typeof disconnected?.resumeApprovedForId === "string" &&
            disconnected.resumeApprovedForId === data.id;
          if (disconnected && (isApprovedResume || shouldAutoResumeSession(disconnected, data, receivedAt))) {
            const restored = disconnected.session;
            mergePendingSession(restored, session);
            restored.convexUserId = convexUserId;
            restored.googleId = String(data.googleId);
            restored.pausedDurationMs =
              (Number(restored.pausedDurationMs) || 0) +
              Math.max(0, receivedAt - (Number(disconnected.disconnectedAt) || receivedAt));
            flightSessions.set(data.id, restored);
            disconnectedSessions.delete(convexUserId);
            updateSessionPosition(restored, data, receivedAt);
            updateSessionMetadata(restored, data);
          } else {
            session.convexUserId = convexUserId;
            session.googleId = String(data.googleId);
            updateSessionPosition(session, data, receivedAt);
            updateSessionMetadata(session, data);
          }
        } else {
          if (convexUserId) session.convexUserId = convexUserId;
          updateSessionPosition(session, data, receivedAt);
          updateSessionMetadata(session, data);
        }
      }
    }

    aircraftMap.set(data.id, {
      ...data,
      ...displayFields,
      role,
      airlineLogo,
      ts: receivedAt,
    });
    markAircraftChanged(data.id);
    broadcast();

  }
  res.sendStatus(200);
});

module.exports = router;
