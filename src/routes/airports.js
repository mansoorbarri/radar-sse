const express = require("express");
const { onlineAirports, persistOnlineAirports } = require("../store");
const { broadcast, markOnlineAirportsChanged } = require("../services/broadcast");
const { normalizeAirportController } = require("../utils/display");
const { createLogger } = require("../utils/logger");

const onlineRouter = express.Router();
const offlineRouter = express.Router();
const log = createLogger("airports");

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
  if (entry) {
    entry.controllers = entry.controllers.map(normalizeAirportController);
  }

  // No existing controllers — first controller auto-assigned "control"
  if (!entry) {
    onlineAirports.set(icao, {
      icao,
      discordInvite: "https://discord.gg/pbQF4txdRC",
      controllers: [
        normalizeAirportController({
          user,
          discordUserId: discordUserId || null,
          position: "control",
          activatedAt: Date.now(),
        }),
      ],
    });

    log.info("Airport marked online", {
      icao,
      user,
      discordUserId: discordUserId || null,
      position: "control",
      controllers: 1,
    });
    persistOnlineAirports();
    markOnlineAirportsChanged();
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
        discordUsername: c.discordUsername || c.user,
        displayName: c.displayName || c.discordUsername || c.user,
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

  // Top-down: any position below the highest staffed position is valid,
  // since higher positions inherently cover lower ones via top-down inheritance.
  // The first controller always gets "control" (the top), so subsequent
  // controllers can take any available position below.

  // Add the new controller
  entry.controllers.push(normalizeAirportController({
    user,
    discordUserId: discordUserId || null,
    position,
    activatedAt: Date.now(),
  }));

  // Sort controllers by hierarchy position (top to bottom)
  entry.controllers.sort((a, b) => POSITIONS.indexOf(a.position) - POSITIONS.indexOf(b.position));

  log.info("Controller added to online airport", {
    icao,
    user,
    discordUserId: discordUserId || null,
    position,
    controllers: entry.controllers.length,
    takenPositions: [...takenPositions],
  });
  persistOnlineAirports();
  markOnlineAirportsChanged();
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

  entry.controllers = entry.controllers.map(normalizeAirportController);

  // Find the controller to remove
  const controllerIdx = entry.controllers.findIndex((c) => c.discordUserId === discordUserId);

  if (controllerIdx === -1 && !isAdmin) {
    return res.status(403).json({ error: `You are not controlling ${icao}. Only active controllers or admins can take it offline.` });
  }

  if (isAdmin && controllerIdx === -1) {
    // Admin removing all controllers
    onlineAirports.delete(icao);
    log.info("Airport marked fully offline by admin", {
      icao,
      discordUserId: discordUserId || null,
      removedControllers: entry.controllers.length,
    });
  } else {
    // Remove just this controller
    const removed = entry.controllers.splice(controllerIdx, 1)[0];
    log.info("Controller removed from airport", {
      icao,
      removedUser: removed.user,
      removedDiscordUserId: removed.discordUserId || null,
      removedPosition: removed.position,
      requestedByDiscordUserId: discordUserId || null,
      isAdmin: Boolean(isAdmin),
      remainingControllers: entry.controllers.length,
    });

    if (entry.controllers.length === 0) {
      // No controllers left — remove the airport entirely
      onlineAirports.delete(icao);
      log.info("Airport marked offline because no controllers remain", {
        icao,
      });
    } else if (entry.controllers.length === 1) {
      // Only one controller left — they become "control" (covers all)
      entry.controllers[0].position = "control";
      entry.controllers[0] = normalizeAirportController(entry.controllers[0]);
      log.info("Remaining controller promoted to control", {
        icao,
        user: entry.controllers[0].user,
        discordUserId: entry.controllers[0].discordUserId || null,
        position: entry.controllers[0].position,
      });
    }
  }

  persistOnlineAirports();
  markOnlineAirportsChanged();
  broadcast();
  res.json({ success: true, icao });
});

module.exports = { onlineRouter, offlineRouter };
