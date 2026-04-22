const express = require("express");
const { convex } = require("../db");
const { MAX_MEMORY_COORDS } = require("../config");
const {
  aircraftMap,
  flightSessions,
  disconnectedSessions,
  getCachedUser,
  setCachedUser,
} = require("../store");
const { broadcast, markAircraftChanged } = require("../services/broadcast");
const { downsampleRoute } = require("../utils/route");
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
  const groundSpeed = Number(data.groundSpeed);
  const indicatedSpeed = Number(data.speed);
  const speed = Number.isFinite(groundSpeed) ? groundSpeed : indicatedSpeed;

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

      // Check cache first to avoid Convex query
      const cached = getCachedUser(searchId);
      if (cached) {
        user = cached.user;
        role = cached.role;
        convexUserId = cached.convexUserId;
        // Only log occasionally to reduce noise (cache hits are frequent)
      } else {
        // Cache miss - query Convex and cache the result
        try {
          user = await convex.query("users:getByGoogleId", {
            googleId: searchId,
          });

          // Cache the result (even if null - prevents repeated lookups for unknown users)
          setCachedUser(searchId, user);

          if (user) {
            role = user.role;
            convexUserId = user._id;
            const authIdentity = buildAuthLogIdentity({
              aircraft: data,
              user,
              googleId: searchId,
            });
            log.info("Resolved authenticated user for position update", {
              aircraftId: data.id,
              callsign: data.callsign,
              flightNo: data.flightNo,
              googleId: searchId,
              convexUserId,
              role,
              identity: authIdentity,
            });
          } else {
            // Explicitly default to FREE when user not found
            role = "FREE";
            const authIdentity = buildAuthLogIdentity({
              aircraft: data,
              googleId: searchId,
            });
            log.info("No user found for position update; defaulting to FREE role", {
              aircraftId: data.id,
              callsign: data.callsign,
              flightNo: data.flightNo,
              googleId: searchId,
              identity: authIdentity,
            });
          }
        } catch (e) {
          // On DB error, also default to FREE (don't cache errors)
          role = "FREE";
          log.error("Failed to resolve user for position update; defaulting to FREE role", {
            aircraftId: data.id,
            callsign: data.callsign,
            flightNo: data.flightNo,
            googleId: searchId,
            error: e,
          });
        }
      }
    }

    const displayFields = buildAircraftDisplayFields({
      aircraft: data,
      user,
    });

    // Log flights for ALL signed-in users (viewing history is restricted in frontend)
    if (convexUserId) {
      // Check if this user has a disconnected session we can restore
      if (!flightSessions.has(data.id) && disconnectedSessions.has(convexUserId)) {
        const { session, originalId } = disconnectedSessions.get(convexUserId);
        log.info("Restoring disconnected flight session after reconnect", {
          flightNo: session.flightNo,
          convexUserId,
          previousAircraftId: originalId,
          currentAircraftId: data.id,
          disconnectedSessions: disconnectedSessions.size,
        });

        // Restore the session with the current aircraft ID
        flightSessions.set(data.id, session);
        disconnectedSessions.delete(convexUserId);

        updateSessionPosition(session, data, receivedAt);
        // Update squawk if provided
        if (data.squawk) {
          session.squawk = data.squawk;
        }
        // Track max altitude and speed
        if (data.altMSL && data.altMSL > session.maxAltitude) {
          session.maxAltitude = data.altMSL;
        }
      } else if (!flightSessions.has(data.id)) {
        // New flight session
        const lat = Number(data.lat);
        const lon = Number(data.lon);
        const initialSpeedKts = getReportedSpeedKts(data) || 0;
        flightSessions.set(data.id, {
          convexUserId: convexUserId,
          callsign: data.callsign || "Unknown",
          flightNo: data.flightNo || "Unknown",
          aircraftType: data.type || "Unknown",
          departure: data.departure || "???",
          arrival: data.arrival || "???",
          squawk: data.squawk || null,
          maxAltitude: data.altMSL || 0,
          maxSpeed: initialSpeedKts,
          statsExcludedReason:
            initialSpeedKts > getStatsMaxSpeedKts(data.type)
              ? STATS_EXCLUDED_SPEED_REASON
              : undefined,
          coords:
            isValidCoordinate(lat, lon) ? [[lat, lon]] : [],
          lastCoord:
            isValidCoordinate(lat, lon) ? [lat, lon] : null,
          lastCoordAt: receivedAt,
          startTime: new Date(),
        });
      } else {
        // Existing active session - add coordinates and update max values
        const session = flightSessions.get(data.id);
        updateSessionPosition(session, data, receivedAt);
        // Update squawk if provided
        if (data.squawk) {
          session.squawk = data.squawk;
        }
        // Track max altitude and speed
        if (data.altMSL && data.altMSL > session.maxAltitude) {
          session.maxAltitude = data.altMSL;
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
