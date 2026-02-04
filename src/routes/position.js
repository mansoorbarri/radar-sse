const express = require("express");
const { convex } = require("../db");
const { MAX_MEMORY_COORDS } = require("../config");
const { aircraftMap, flightSessions, disconnectedSessions } = require("../store");
const { broadcast, markAircraftChanged } = require("../services/broadcast");
const { checkAndNotifyMissingImage } = require("../services/imageNotifier");
const { downsampleRoute } = require("../utils/route");

const router = express.Router();

// Add coordinate to session with memory limit enforcement
function addCoordToSession(session, lat, lon) {
  const last = session.coords[session.coords.length - 1];
  // Only add if moved enough
  if (Math.abs(last[0] - lat) > 0.0002 || Math.abs(last[1] - lon) > 0.0002) {
    session.coords.push([lat, lon]);

    // Downsample if exceeding memory limit
    if (session.coords.length > MAX_MEMORY_COORDS) {
      const targetSize = Math.floor(MAX_MEMORY_COORDS * 0.75); // Downsample to 75% to avoid frequent resampling
      session.coords = downsampleRoute(session.coords, targetSize);
      console.log(`[MEMORY] Downsampled ${session.flightNo} coords to ${session.coords.length}`);
    }
  }
}

router.post("/", async (req, res) => {
  const data = req.body;
  if (data.id) {
    let role = "FREE"; // Default to FREE
    const airlineLogo = null;
    let convexUserId = null;

    if (data.googleId) {
      try {
        const searchId = String(data.googleId);
        const user = await convex.query("users:getByGoogleId", {
          googleId: searchId,
        });

        if (user) {
          role = user.role;
          convexUserId = user._id;
          console.log(
            `[AUTH] Found ${user.clerkId} | Role: ${role} | ID: ${convexUserId}`
          );
        } else {
          // Explicitly default to FREE when user not found
          role = "FREE";
          console.log(
            `[AUTH] No user found for ID: ${searchId} - defaulting to FREE`
          );
        }
      } catch (e) {
        // On DB error, also default to FREE
        role = "FREE";
        console.error("[DB ERROR] Defaulting to FREE role:", e);
      }
    }

    // Log flights for ALL signed-in users (viewing history is restricted in frontend)
    if (convexUserId) {
      // Check if this user has a disconnected session we can restore
      if (!flightSessions.has(data.id) && disconnectedSessions.has(convexUserId)) {
        const { session, originalId } = disconnectedSessions.get(convexUserId);
        console.log(`[RECONNECT] Restoring flight session for ${session.flightNo} (was ${originalId}, now ${data.id})`);

        // Restore the session with the current aircraft ID
        flightSessions.set(data.id, session);
        disconnectedSessions.delete(convexUserId);

        // Add current position
        addCoordToSession(session, data.lat, data.lon);
        // Update squawk if provided
        if (data.squawk) {
          session.squawk = data.squawk;
        }
        // Track max altitude and speed
        if (data.altMSL && data.altMSL > session.maxAltitude) {
          session.maxAltitude = data.altMSL;
        }
        if (data.speed && data.speed > session.maxSpeed) {
          session.maxSpeed = data.speed;
        }
      } else if (!flightSessions.has(data.id)) {
        // New flight session
        flightSessions.set(data.id, {
          convexUserId: convexUserId,
          callsign: data.callsign || "Unknown",
          flightNo: data.flightNo || "Unknown",
          aircraftType: data.type || "Unknown",
          departure: data.departure || "???",
          arrival: data.arrival || "???",
          squawk: data.squawk || null,
          maxAltitude: data.altMSL || 0,
          maxSpeed: data.speed || 0,
          coords: [[data.lat, data.lon]],
          startTime: new Date(),
        });
      } else {
        // Existing active session - add coordinates and update max values
        const session = flightSessions.get(data.id);
        addCoordToSession(session, data.lat, data.lon);
        // Update squawk if provided
        if (data.squawk) {
          session.squawk = data.squawk;
        }
        // Track max altitude and speed
        if (data.altMSL && data.altMSL > session.maxAltitude) {
          session.maxAltitude = data.altMSL;
        }
        if (data.speed && data.speed > session.maxSpeed) {
          session.maxSpeed = data.speed;
        }
      }
    }

    aircraftMap.set(data.id, {
      ...data,
      role,
      airlineLogo,
      ts: Date.now(),
    });
    markAircraftChanged(data.id);
    broadcast();

    // Check for missing aircraft image (fire and forget - don't block response)
    checkAndNotifyMissingImage(data.flightNo, data.type);
  }
  res.sendStatus(200);
});

module.exports = router;
