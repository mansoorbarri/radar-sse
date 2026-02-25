const express = require("express");
const { onlineAirports } = require("../store");
const { broadcast } = require("../services/broadcast");

const onlineRouter = express.Router();
const offlineRouter = express.Router();

const ICAO_REGEX = /^[A-Z]{4}$/;

// POST /api/airport-online — mark an airport as having ATC online
onlineRouter.post("/", (req, res) => {
  const { icao, user } = req.body;

  if (!icao || !ICAO_REGEX.test(icao)) {
    return res.status(400).json({ error: "Invalid ICAO code (must be 4 uppercase letters)" });
  }

  if (!user) {
    return res.status(400).json({ error: "Missing user" });
  }

  onlineAirports.set(icao, {
    icao,
    user,
    discordInvite: "https://discord.gg/pbQF4txdRC",
    activatedAt: Date.now(),
  });

  console.log(`[ATC] ${user} marked ${icao} as online`);
  broadcast();
  res.json({ success: true, icao });
});

// POST /api/airport-offline — remove ATC from an airport
offlineRouter.post("/", (req, res) => {
  const { icao } = req.body;

  if (!icao || !ICAO_REGEX.test(icao)) {
    return res.status(400).json({ error: "Invalid ICAO code (must be 4 uppercase letters)" });
  }

  const existed = onlineAirports.delete(icao);

  console.log(`[ATC] ${icao} marked as offline (was active: ${existed})`);
  broadcast();
  res.json({ success: true, icao, wasActive: existed });
});

module.exports = { onlineRouter, offlineRouter };
