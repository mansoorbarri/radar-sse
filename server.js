require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { ConvexHttpClient } = require("convex/browser");

const app = express();

// Initialize Convex client
const convexUrl = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  console.error("CONVEX_URL or NEXT_PUBLIC_CONVEX_URL environment variable is required");
  process.exit(1);
}
const convex = new ConvexHttpClient(convexUrl);

app.use(cors());
app.use(express.json());

let aircraftMap = new Map();
let subscribers = [];
let flightSessions = new Map();
let commandQueue = new Map(); // Stores pending commands per aircraft: id -> [commands]
let disconnectedSessions = new Map(); // convexUserId -> { session, originalId, disconnectedAt }

// Grace period before finalizing a flight after disconnect (3 minutes)
const GRACE_PERIOD_MS = 180000;

function broadcast() {
  const message = JSON.stringify({
    count: aircraftMap.size,
    aircraft: Array.from(aircraftMap.values()),
    timestamp: new Date().toISOString(),
  });
  subscribers.forEach((s) => s.res.write(`data: ${message}\n\n`));
}

async function finalizeFlight(id) {
  const session = flightSessions.get(id);
  if (!session) return;

  try {
    if (session.coords.length > 2) {
      await convex.mutation("flights:create", {
        userId: session.convexUserId,
        callsign: session.callsign,
        aircraftType: session.aircraftType,
        depICAO: session.departure,
        arrICAO: session.arrival,
        routeData: session.coords,
        startTime: session.startTime.getTime(),
        endTime: Date.now(),
      });
    }
  } catch (e) {
    console.error(e);
  } finally {
    flightSessions.delete(id);
  }
}

// Finalize a disconnected session after grace period expires
async function finalizeDisconnectedSession(convexUserId) {
  const data = disconnectedSessions.get(convexUserId);
  if (!data) return;

  const { session } = data;
  console.log(`[FINALIZE] Grace period expired for user ${convexUserId}, saving flight`);

  try {
    if (session.coords.length > 2) {
      await convex.mutation("flights:create", {
        userId: session.convexUserId,
        callsign: session.callsign,
        aircraftType: session.aircraftType,
        depICAO: session.departure,
        arrICAO: session.arrival,
        routeData: session.coords,
        startTime: session.startTime.getTime(),
        endTime: Date.now(),
      });
      console.log(`[FINALIZE] Flight saved for ${session.callsign}`);
    }
  } catch (e) {
    console.error("[FINALIZE] Error saving flight:", e);
  } finally {
    disconnectedSessions.delete(convexUserId);
  }
}

app.post("/api/atc/position", async (req, res) => {
  const data = req.body;
  if (data.id) {
    let role = "FREE"; // Default to FREE
    let airlineLogo = null;
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
        console.log(`[RECONNECT] Restoring flight session for ${session.callsign} (was ${originalId}, now ${data.id})`);

        // Restore the session with the current aircraft ID
        flightSessions.set(data.id, session);
        disconnectedSessions.delete(convexUserId);

        // Add current position
        const last = session.coords[session.coords.length - 1];
        if (
          Math.abs(last[0] - data.lat) > 0.0002 ||
          Math.abs(last[1] - data.lon) > 0.0002
        ) {
          session.coords.push([data.lat, data.lon]);
        }
      } else if (!flightSessions.has(data.id)) {
        // New flight session
        flightSessions.set(data.id, {
          convexUserId: convexUserId,
          callsign: data.callsign || "Unknown",
          aircraftType: data.type || "Unknown",
          departure: data.departure || "???",
          arrival: data.arrival || "???",
          coords: [[data.lat, data.lon]],
          startTime: new Date(),
        });
      } else {
        // Existing active session - add coordinates
        let session = flightSessions.get(data.id);
        const last = session.coords[session.coords.length - 1];
        if (
          Math.abs(last[0] - data.lat) > 0.0002 ||
          Math.abs(last[1] - data.lon) > 0.0002
        ) {
          session.coords.push([data.lat, data.lon]);
        }
      }
    }

    aircraftMap.set(data.id, {
      ...data,
      role,
      airlineLogo,
      ts: Date.now(),
    });
    broadcast();
  }
  res.sendStatus(200);
});

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const initial = JSON.stringify({
    count: aircraftMap.size,
    aircraft: Array.from(aircraftMap.values()),
  });
  res.write(`data: ${initial}\n\n`);

  const id = Date.now();
  subscribers.push({ id, res });

  req.on("close", () => {
    subscribers = subscribers.filter((s) => s.id !== id);
  });
});

// Send command to an aircraft (called from RadarThing web app)
app.post("/api/command", (req, res) => {
  const { targetId, targetCallsign, targetGoogleId, command } = req.body;

  if (!command || !command.type) {
    return res.status(400).json({ error: "Missing command or command.type" });
  }

  // Find the aircraft by id, callsign, or googleId
  let aircraftId = targetId;
  if (!aircraftId) {
    for (const [id, aircraft] of aircraftMap.entries()) {
      if (
        (targetCallsign && aircraft.callsign === targetCallsign) ||
        (targetGoogleId && aircraft.googleId === targetGoogleId)
      ) {
        aircraftId = id;
        break;
      }
    }
  }

  if (!aircraftId) {
    return res.status(404).json({ error: "Aircraft not found" });
  }

  // Add command to queue
  const commands = commandQueue.get(aircraftId) || [];
  commands.push({
    ...command,
    ts: Date.now(),
  });
  commandQueue.set(aircraftId, commands);

  console.log(`[CMD] Queued ${command.type} for ${aircraftId}`);
  res.json({ success: true, queueLength: commands.length });
});

// Fetch pending commands for an aircraft (called from userscript)
app.get("/api/commands/:id", (req, res) => {
  const { id } = req.params;
  const commands = commandQueue.get(id) || [];

  // Clear the queue after fetching
  if (commands.length > 0) {
    commandQueue.delete(id);
    console.log(`[CMD] Delivered ${commands.length} commands to ${id}`);
  }

  res.json({ commands });
});

// Check for aircraft that stopped sending updates (12 second timeout)
// Moves flight sessions to grace period instead of finalizing immediately
setInterval(() => {
  const now = Date.now();
  for (const [id, aircraft] of aircraftMap.entries()) {
    if (now - (aircraft.ts || 0) > 12000) {
      const session = flightSessions.get(id);
      if (session) {
        console.log(
          `[DISCONNECT] ${id} (${session.callsign}) disconnected, entering grace period`
        );
        // Move to disconnected sessions instead of finalizing
        disconnectedSessions.set(session.convexUserId, {
          session,
          originalId: id,
          disconnectedAt: now,
        });
        flightSessions.delete(id);
      } else {
        console.log(`[TIMEOUT] ${id} timed out (no active session)`);
      }
      aircraftMap.delete(id);
      commandQueue.delete(id); // Clean up stale commands
    }
  }
}, 5000);

// Check for disconnected sessions that have exceeded the grace period
setInterval(() => {
  const now = Date.now();
  for (const [convexUserId, data] of disconnectedSessions.entries()) {
    if (now - data.disconnectedAt > GRACE_PERIOD_MS) {
      finalizeDisconnectedSession(convexUserId);
    }
  }
}, 30000); // Check every 30 seconds

app.listen(process.env.PORT || 3001, "0.0.0.0", () => {
  console.log(`[SSE Server] Running on http://localhost:${process.env.PORT || 3001}`);
});
