const express = require("express");
const { onlineAirports } = require("../store");
const { broadcast } = require("../services/broadcast");

const onlineRouter = express.Router();
const offlineRouter = express.Router();

const ICAO_REGEX = /^[A-Z]{4}$/;

// POST /api/airport-online — mark an airport as having ATC online
onlineRouter.post("/", (req, res) => {
  const { icao, user, discordUserId } = req.body;

  if (!icao || !ICAO_REGEX.test(icao)) {
    return res.status(400).json({ error: "Invalid ICAO code (must be 4 uppercase letters)" });
  }

  if (!user) {
    return res.status(400).json({ error: "Missing user" });
  }

  onlineAirports.set(icao, {
    icao,
    user,
    discordUserId: discordUserId || null,
    discordInvite: "https://discord.gg/pbQF4txdRC",
    activatedAt: Date.now(),
  });

  console.log(`[ATC] ${user} (${discordUserId || "unknown"}) marked ${icao} as online`);
  broadcast();
  res.json({ success: true, icao });
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

  // Only the user who activated it or an admin can take it offline
  if (entry.discordUserId && discordUserId !== entry.discordUserId && !isAdmin) {
    return res.status(403).json({ error: `Only the controller who activated ${icao} or an admin can take it offline` });
  }

  onlineAirports.delete(icao);

  console.log(`[ATC] ${icao} marked as offline by ${discordUserId || "unknown"}${isAdmin ? " (admin)" : ""}`);
  broadcast();
  res.json({ success: true, icao });
});

module.exports = { onlineRouter, offlineRouter };
