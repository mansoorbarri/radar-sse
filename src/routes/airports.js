const express = require("express");
const { onlineAirports } = require("../store");
const { broadcast } = require("../services/broadcast");

const onlineRouter = express.Router();
const offlineRouter = express.Router();

const ICAO_REGEX = /^[A-Z]{4}$/;
const POSITIONS = ["control", "tower", "ground", "delivery"];

// POST /api/airport-online — mark an airport as having ATC online
onlineRouter.post("/", (req, res) => {
  const { icao, user, discordUserId, position } = req.body;

  if (!icao || !ICAO_REGEX.test(icao)) {
    return res.status(400).json({ error: "Invalid ICAO code (must be 4 uppercase letters)" });
  }

  if (!user) {
    return res.status(400).json({ error: "Missing user" });
  }

  const entry = onlineAirports.get(icao);

  // No existing controllers — first controller auto-assigned "control"
  if (!entry) {
    onlineAirports.set(icao, {
      icao,
      discordInvite: "https://discord.gg/pbQF4txdRC",
      controllers: [
        {
          user,
          discordUserId: discordUserId || null,
          position: "control",
          activatedAt: Date.now(),
        },
      ],
    });

    console.log(`[ATC] ${user} (${discordUserId || "unknown"}) marked ${icao} as online (control)`);
    broadcast();
    return res.json({ success: true, icao, position: "control" });
  }

  // Check if this user is already controlling at this airport
  const existingIdx = entry.controllers.findIndex((c) => c.discordUserId === discordUserId);
  if (existingIdx !== -1) {
    return res.status(409).json({ error: `You are already controlling ${icao} as ${entry.controllers[existingIdx].position}` });
  }

  // Airport already has controllers — position selection required
  const takenPositions = new Set(entry.controllers.map((c) => c.position));
  const availablePositions = POSITIONS.filter((p) => !takenPositions.has(p));

  if (availablePositions.length === 0) {
    return res.status(409).json({ error: `All positions at ${icao} are already staffed` });
  }

  if (!position) {
    // No position specified — tell the bot to ask the user
    return res.json({
      success: false,
      needsSelection: true,
      icao,
      availablePositions,
      existingControllers: entry.controllers.map((c) => ({
        user: c.user,
        position: c.position,
      })),
    });
  }

  // Validate the requested position
  if (!POSITIONS.includes(position)) {
    return res.status(400).json({ error: `Invalid position: ${position}. Must be one of: ${POSITIONS.join(", ")}` });
  }

  if (takenPositions.has(position)) {
    return res.status(409).json({ error: `${position} at ${icao} is already staffed by ${entry.controllers.find((c) => c.position === position).user}` });
  }

  // Validate top-down: new controller's position + existing positions must not create gaps
  // A gap would be: someone at control and someone at delivery with no one at tower or ground
  // Rule: the set of taken positions must be contiguous from the top
  const newPositions = [...takenPositions, position].sort((a, b) => POSITIONS.indexOf(a) - POSITIONS.indexOf(b));

  // Check contiguity: each taken position must be adjacent in the hierarchy to the next
  for (let i = 0; i < newPositions.length - 1; i++) {
    const currentIdx = POSITIONS.indexOf(newPositions[i]);
    const nextIdx = POSITIONS.indexOf(newPositions[i + 1]);
    if (nextIdx - currentIdx > 1) {
      // There's a gap — this would violate top-down
      const missingPositions = POSITIONS.slice(currentIdx + 1, nextIdx);
      return res.status(400).json({
        error: `Top-down violation: adding ${position} would leave ${missingPositions.join(", ")} unstaffed between ${newPositions[i]} and ${newPositions[i + 1]}`,
      });
    }
  }

  // Add the new controller
  entry.controllers.push({
    user,
    discordUserId: discordUserId || null,
    position,
    activatedAt: Date.now(),
  });

  // Sort controllers by hierarchy position (top to bottom)
  entry.controllers.sort((a, b) => POSITIONS.indexOf(a.position) - POSITIONS.indexOf(b.position));

  console.log(`[ATC] ${user} (${discordUserId || "unknown"}) marked ${icao} as ${position}`);
  broadcast();
  return res.json({ success: true, icao, position });
});

// POST /api/airport-offline — remove ATC from an airport
offlineRouter.post("/", (req, res) => {
  const { icao, discordUserId, isAdmin } = req.body;

  if (!icao || !ICAO_REGEX.test(icao)) {
    return res.status(400).json({ error: "Invalid ICAO code (must be 4 uppercase letters)" });
  }

  const entry = onlineAirports.get(icao);
  if (!entry) {
    return res.status(404).json({ error: `${icao} is not currently online` });
  }

  // Find the controller to remove
  const controllerIdx = entry.controllers.findIndex((c) => c.discordUserId === discordUserId);

  if (controllerIdx === -1 && !isAdmin) {
    return res.status(403).json({ error: `You are not controlling ${icao}. Only active controllers or admins can take it offline.` });
  }

  if (isAdmin && controllerIdx === -1) {
    // Admin removing all controllers
    onlineAirports.delete(icao);
    console.log(`[ATC] ${icao} marked as fully offline by admin ${discordUserId || "unknown"}`);
  } else {
    // Remove just this controller
    const removed = entry.controllers.splice(controllerIdx, 1)[0];
    console.log(`[ATC] ${removed.user} (${removed.position}) removed from ${icao} by ${discordUserId || "unknown"}${isAdmin ? " (admin)" : ""}`);

    if (entry.controllers.length === 0) {
      // No controllers left — remove the airport entirely
      onlineAirports.delete(icao);
      console.log(`[ATC] ${icao} fully offline (no controllers remaining)`);
    } else if (entry.controllers.length === 1) {
      // Only one controller left — they become "control" (covers all)
      entry.controllers[0].position = "control";
      console.log(`[ATC] ${entry.controllers[0].user} now covers all positions at ${icao}`);
    }
  }

  broadcast();
  res.json({ success: true, icao });
});

module.exports = { onlineRouter, offlineRouter };
