const express = require("express");
const { convex } = require("../db");
const { MAX_RETRIES } = require("../config");
const { aircraftMap, flightSessions, disconnectedSessions, commandQueue } = require("../store");
const { broadcast, markAircraftRemoved } = require("../services/broadcast");
const { finalizeFlight, finalizeDisconnectedSession } = require("../services/session");

const router = express.Router();

function normalizeFlightIdentifier(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

async function findSessionByQuery({ id, callsign, googleId }) {
  if (id && flightSessions.has(id)) {
    return {
      state: "active",
      aircraftId: id,
      session: flightSessions.get(id),
    };
  }

  const normalizedCallsign = normalizeFlightIdentifier(callsign);
  if (normalizedCallsign) {
    for (const [aircraftId, session] of flightSessions.entries()) {
      const identifiers = [
        normalizeFlightIdentifier(session.flightNo),
        normalizeFlightIdentifier(session.callsign),
      ];
      if (identifiers.includes(normalizedCallsign)) {
        return {
          state: "active",
          aircraftId,
          session,
        };
      }
    }
  }

  let convexUserId = null;
  if (googleId) {
    const user = await convex.query("users:getByGoogleId", {
      googleId: String(googleId),
    });
    convexUserId = user?._id ?? null;

    if (convexUserId) {
      for (const [aircraftId, session] of flightSessions.entries()) {
        if (session.convexUserId === convexUserId) {
          return {
            state: "active",
            aircraftId,
            session,
          };
        }
      }
    }
  }

  if (id) {
    for (const [sessionUserId, data] of disconnectedSessions.entries()) {
      if (data.originalId === id) {
        return {
          state: "disconnected",
          aircraftId: data.originalId,
          convexUserId: sessionUserId,
          session: data.session,
        };
      }
    }
  }

  if (normalizedCallsign) {
    for (const [sessionUserId, data] of disconnectedSessions.entries()) {
      const identifiers = [
        normalizeFlightIdentifier(data.session.flightNo),
        normalizeFlightIdentifier(data.session.callsign),
      ];
      if (identifiers.includes(normalizedCallsign)) {
        return {
          state: "disconnected",
          aircraftId: data.originalId,
          convexUserId: sessionUserId,
          session: data.session,
        };
      }
    }
  }

  if (convexUserId && disconnectedSessions.has(convexUserId)) {
    const data = disconnectedSessions.get(convexUserId);
    return {
      state: "disconnected",
      aircraftId: data.originalId,
      convexUserId,
      session: data.session,
    };
  }

  return null;
}

// List failed sessions that can be retried
router.get("/failed-flights", (req, res) => {
  const failed = [];

  // Check active sessions with failures
  for (const [id, session] of flightSessions.entries()) {
    if (session.failedAt) {
      failed.push({
        type: "active",
        id,
        flightNo: session.flightNo,
        convexUserId: session.convexUserId,
        coordsCount: session.coords.length,
        failedAt: session.failedAt,
        lastError: session.lastError,
        retryCount: session.retryCount || 0,
        maxRetries: MAX_RETRIES,
        autoRetryExhausted: (session.retryCount || 0) >= MAX_RETRIES,
      });
    }
  }

  // Check disconnected sessions with failures
  for (const [convexUserId, data] of disconnectedSessions.entries()) {
    if (data.failedAt) {
      failed.push({
        type: "disconnected",
        convexUserId,
        flightNo: data.session.flightNo,
        coordsCount: data.session.coords.length,
        failedAt: data.failedAt,
        lastError: data.lastError,
        retryCount: data.retryCount || 0,
        maxRetries: MAX_RETRIES,
        autoRetryExhausted: (data.retryCount || 0) >= MAX_RETRIES,
      });
    }
  }

  res.json({ failed, count: failed.length });
});

router.get("/active-flight-path", async (req, res) => {
  const id =
    typeof req.query.id === "string" ? req.query.id.trim() : undefined;
  const callsign =
    typeof req.query.callsign === "string"
      ? req.query.callsign.trim()
      : undefined;
  const googleId =
    typeof req.query.googleId === "string"
      ? req.query.googleId.trim()
      : undefined;

  if (!id && !callsign && !googleId) {
    return res.status(400).json({
      error: "Missing id, callsign, or googleId",
    });
  }

  try {
    const match = await findSessionByQuery({ id, callsign, googleId });

    if (!match || !match.session) {
      return res.status(404).json({
        error: "No active flight session found",
      });
    }

    return res.json({
      state: match.state,
      aircraftId: match.aircraftId,
      callsign: match.session.flightNo || match.session.callsign,
      aircraftType: match.session.aircraftType,
      depICAO: match.session.departure,
      arrICAO: match.session.arrival,
      startTime:
        match.session.startTime instanceof Date
          ? match.session.startTime.getTime()
          : new Date(match.session.startTime).getTime(),
      endTime: match.session.endTime || undefined,
      routeData: match.session.coords,
    });
  } catch (error) {
    console.error("[ACTIVE-FLIGHT-PATH] Failed to fetch active session:", error);
    return res.status(500).json({
      error: "Failed to fetch active flight path",
    });
  }
});

// Retry saving a failed flight (manual retry resets the counter for 3 more attempts)
router.post("/retry-flight", async (req, res) => {
  const { id, convexUserId } = req.body;

  if (!id && !convexUserId) {
    return res.status(400).json({ error: "Missing id or convexUserId" });
  }

  // Try active sessions first
  if (id && flightSessions.has(id)) {
    const session = flightSessions.get(id);
    if (!session.failedAt) {
      return res.status(400).json({ error: "Session has not failed, cannot retry" });
    }
    console.log(`[RETRY] Manual retry for flight ${session.flightNo} (id: ${id}), resetting retry counter`);
    session.retryCount = 0; // Reset for 3 more auto-retry attempts
    const result = await finalizeFlight(id, true);
    return res.json(result);
  }

  // Try disconnected sessions
  if (convexUserId && disconnectedSessions.has(convexUserId)) {
    const data = disconnectedSessions.get(convexUserId);
    if (!data.failedAt) {
      return res.status(400).json({ error: "Session has not failed, cannot retry" });
    }
    console.log(`[RETRY] Manual retry for flight ${data.session.flightNo} (convexUserId: ${convexUserId}), resetting retry counter`);
    data.retryCount = 0; // Reset for 3 more auto-retry attempts
    const result = await finalizeDisconnectedSession(convexUserId, true);
    return res.json(result);
  }

  return res.status(404).json({ error: "No failed session found with that id or convexUserId" });
});

// End flight immediately (called when user clicks Clear in the UI)
router.post("/end-flight", async (req, res) => {
  const { id, googleId } = req.body;
  console.log(`[END-FLIGHT] Request received: id=${id}, googleId=${googleId}`);
  console.log(`[END-FLIGHT] Active sessions: ${flightSessions.size}, Disconnected: ${disconnectedSessions.size}`);

  if (!id && !googleId) {
    return res.status(400).json({ error: "Missing id or googleId" });
  }

  let finalized = false;
  let sessionInfo = null;

  // First, check active flight sessions by aircraft ID
  if (id && flightSessions.has(id)) {
    const session = flightSessions.get(id);
    sessionInfo = { flightNo: session.flightNo, convexUserId: session.convexUserId };
    console.log(`[END-FLIGHT] Finalizing active session for ${session.flightNo} (id: ${id})`);
    await finalizeFlight(id);
    finalized = true;
  }

  // If not found by ID, try to find by googleId in active sessions
  if (!finalized && googleId) {
    for (const [aircraftId, session] of flightSessions.entries()) {
      if (session.convexUserId) {
        // We need to check if the googleId maps to this convexUserId
        // Since we store convexUserId, check disconnectedSessions which stores by convexUserId
        // For active sessions, we'll need to iterate and match
        try {
          const user = await convex.query("users:getByGoogleId", { googleId: String(googleId) });
          if (user && user._id === session.convexUserId) {
            sessionInfo = { flightNo: session.flightNo, convexUserId: session.convexUserId };
            console.log(`[END-FLIGHT] Finalizing active session for ${session.flightNo} (found by googleId)`);
            await finalizeFlight(aircraftId);
            finalized = true;
            break;
          }
        } catch (e) {
          console.error("[END-FLIGHT] Error looking up user:", e);
        }
      }
    }
  }

  // Check disconnected sessions (in grace period) - first by original ID
  if (!finalized && id) {
    for (const [convexUserId, data] of disconnectedSessions.entries()) {
      if (data.originalId === id) {
        sessionInfo = { flightNo: data.session.flightNo, convexUserId };
        console.log(`[END-FLIGHT] Finalizing disconnected session for ${data.session.flightNo} (found by originalId)`);
        await finalizeDisconnectedSession(convexUserId);
        finalized = true;
        break;
      }
    }
  }

  // Check disconnected sessions by googleId lookup
  if (!finalized && googleId) {
    try {
      const user = await convex.query("users:getByGoogleId", { googleId: String(googleId) });
      if (user && disconnectedSessions.has(user._id)) {
        const data = disconnectedSessions.get(user._id);
        sessionInfo = { flightNo: data.session.flightNo, convexUserId: user._id };
        console.log(`[END-FLIGHT] Finalizing disconnected session for ${data.session.flightNo} (found by googleId)`);
        await finalizeDisconnectedSession(user._id);
        finalized = true;
      }
    } catch (e) {
      console.error("[END-FLIGHT] Error looking up user for disconnected session:", e);
    }
  }

  // Remove from aircraftMap if present
  if (id && aircraftMap.has(id)) {
    markAircraftRemoved(id);
    aircraftMap.delete(id);
    commandQueue.delete(id);
    broadcast();
  }

  if (finalized) {
    console.log(`[END-FLIGHT] Successfully ended flight for ${sessionInfo?.flightNo}`);
    return res.json({ success: true, finalized: true, flightNo: sessionInfo?.flightNo });
  } else {
    console.log(`[END-FLIGHT] No active session found for id=${id}, googleId=${googleId}`);
    return res.json({ success: true, finalized: false, reason: "No active session found" });
  }
});

module.exports = router;
