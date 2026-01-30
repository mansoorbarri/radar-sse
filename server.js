require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { ConvexHttpClient } = require("convex/browser");

const app = express();

// Discord webhook for missing image notifications
const DISCORD_WEBHOOK_URL = process.env.DISCORD_MISSING_IMAGE_WEBHOOK;

// Initialize Convex client
const convexUrl = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  console.error("CONVEX_URL or NEXT_PUBLIC_CONVEX_URL environment variable is required");
  process.exit(1);
}
const convex = new ConvexHttpClient(convexUrl);

// Extract airline code from callsign (e.g., "UAE123" -> "UAE", "EK456" -> "EK")
function extractAirlineCode(callsign) {
  if (!callsign) return null;
  const match = callsign.match(/^([A-Z]{2,3})/i);
  return match ? match[1].toUpperCase() : null;
}

// Normalize aircraft type from GeoFS format to DB format
// e.g., "Boeing 777-300ER" -> "B777", "Airbus A320" -> "A320"
function normalizeAircraftType(type) {
  if (!type) return null;
  const upper = type.toUpperCase();

  // Boeing: "BOEING 777-300ER" -> "B777"
  const boeingMatch = upper.match(/BOEING\s+(\d{3})/);
  if (boeingMatch) return `B${boeingMatch[1]}`;

  // Airbus: "AIRBUS A320" -> "A320"
  const airbusMatch = upper.match(/AIRBUS\s+(A\d{3})/);
  if (airbusMatch) return airbusMatch[1];

  // Already in short format (e.g., "B737", "A320")
  const shortMatch = upper.match(/^[AB]\d{3}$/);
  if (shortMatch) return upper;

  return null;
}

// Check for missing aircraft image and notify Discord
async function checkAndNotifyMissingImage(flightNo, aircraftType) {
  if (!DISCORD_WEBHOOK_URL || !flightNo || !aircraftType) return;

  const airlineCode = extractAirlineCode(flightNo);
  if (!airlineCode) return;

  const normalizedType = normalizeAircraftType(aircraftType);
  if (!normalizedType) return; // Unknown aircraft type format

  try {
    // Check if we already sent a notification for this combo (stored in Convex)
    const alreadyNotified = await convex.query("missingImageNotifications:exists", {
      airlineCode: airlineCode,
      aircraftType: normalizedType,
    });

    if (alreadyNotified) return;

    // Check if approved image exists
    const image = await convex.query("aircraftImages:getApprovedImage", {
      airlineCode: airlineCode,
      aircraftType: normalizedType,
    });

    if (image) return; // Image exists, nothing to do

    // Create notification record FIRST to prevent race conditions
    await convex.mutation("missingImageNotifications:create", {
      airlineCode: airlineCode,
      aircraftType: normalizedType,
    });

    // Send Discord notification with ?wait=true to get message ID
    const webhookUrlWithWait = `${DISCORD_WEBHOOK_URL}?wait=true`;
    const response = await fetch(webhookUrlWithWait, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: "Missing Aircraft Image",
            description: `No approved image found for **${airlineCode}** flying a **${normalizedType}**\n\n[Upload an image](https://radarthing.com/aircraft-images)`,
            color: 0xffa500, // Orange
            fields: [
              { name: "Callsign", value: flightNo, inline: true },
              { name: "Aircraft", value: normalizedType, inline: true },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });

    if (response.ok) {
      const data = await response.json();
      // Update record with Discord message ID for later deletion
      await convex.mutation("missingImageNotifications:updateMessageId", {
        airlineCode: airlineCode,
        aircraftType: normalizedType,
        discordMessageId: data.id,
      });
      console.log(`[NOTIFY] Missing image for ${airlineCode}-${normalizedType} (msg: ${data.id})`);
    } else {
      console.log(`[NOTIFY] Missing image for ${airlineCode}-${normalizedType} (no msg ID, status: ${response.status})`);
    }
  } catch (e) {
    console.error("[NOTIFY] Error checking/sending notification:", e.message);
  }
}

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
      const endTime = Date.now();
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
        routeData: session.coords,
        startTime: session.startTime.getTime(),
        endTime: endTime,
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
      const endTime = Date.now();
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
        routeData: session.coords,
        startTime: session.startTime.getTime(),
        endTime: endTime,
      });
      console.log(`[FINALIZE] Flight saved for ${session.flightNo}`);
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
        console.log(`[RECONNECT] Restoring flight session for ${session.flightNo} (was ${originalId}, now ${data.id})`);

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
        let session = flightSessions.get(data.id);
        const last = session.coords[session.coords.length - 1];
        if (
          Math.abs(last[0] - data.lat) > 0.0002 ||
          Math.abs(last[1] - data.lon) > 0.0002
        ) {
          session.coords.push([data.lat, data.lon]);
        }
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
    broadcast();

    // Check for missing aircraft image (fire and forget - don't block response)
    checkAndNotifyMissingImage(data.flightNo, data.type);
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

// End flight immediately (called when user clicks Clear in the UI)
app.post("/api/end-flight", async (req, res) => {
  const { id, googleId } = req.body;

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

  // Check disconnected sessions (in grace period)
  if (!finalized && googleId) {
    try {
      const user = await convex.query("users:getByGoogleId", { googleId: String(googleId) });
      if (user && disconnectedSessions.has(user._id)) {
        const data = disconnectedSessions.get(user._id);
        sessionInfo = { flightNo: data.session.flightNo, convexUserId: user._id };
        console.log(`[END-FLIGHT] Finalizing disconnected session for ${data.session.flightNo}`);
        await finalizeDisconnectedSession(user._id);
        finalized = true;
      }
    } catch (e) {
      console.error("[END-FLIGHT] Error looking up user for disconnected session:", e);
    }
  }

  // Remove from aircraftMap if present
  if (id && aircraftMap.has(id)) {
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

// Delete Discord notification when an aircraft image is uploaded
app.post("/api/image-uploaded", async (req, res) => {
  const { airlineCode, aircraftType } = req.body;

  if (!airlineCode || !aircraftType) {
    return res.status(400).json({ error: "Missing airlineCode or aircraftType" });
  }

  try {
    // Remove from Convex and get the Discord message ID
    const result = await convex.mutation("missingImageNotifications:remove", {
      airlineCode: airlineCode,
      aircraftType: aircraftType,
    });

    if (!result.deleted || !result.discordMessageId) {
      console.log(`[NOTIFY] No notification found for ${airlineCode}-${aircraftType}`);
      return res.json({ success: true, deleted: false, reason: "No notification found" });
    }

    // Delete the Discord message using webhook
    if (DISCORD_WEBHOOK_URL) {
      const deleteUrl = `${DISCORD_WEBHOOK_URL}/messages/${result.discordMessageId}`;
      const response = await fetch(deleteUrl, { method: "DELETE" });

      if (response.ok || response.status === 204) {
        console.log(`[NOTIFY] Deleted Discord notification for ${airlineCode}-${aircraftType}`);
        return res.json({ success: true, deleted: true });
      } else {
        console.error(`[NOTIFY] Failed to delete Discord message: ${response.status}`);
        return res.json({ success: true, deleted: false, reason: "Discord API error" });
      }
    }

    return res.json({ success: true, deleted: true });
  } catch (e) {
    console.error("[NOTIFY] Error deleting notification:", e.message);
    return res.json({ success: true, deleted: false, reason: e.message });
  }
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
          `[DISCONNECT] ${id} (${session.flightNo}) disconnected, entering grace period`
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
