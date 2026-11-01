const express = require("express");
const { aircraftMap, commandQueue } = require("../store");
const { takeQueuedCommands } = require("../services/commands");
const { createLogger } = require("../utils/logger");

const router = express.Router();
const log = createLogger("commands");

// Send command to an aircraft (called from RadarThing web app)
router.post("/", (req, res) => {
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

  log.info("Queued aircraft command", {
    aircraftId,
    commandType: command.type,
    targetId,
    targetCallsign,
    targetGoogleId,
    queueLength: commands.length,
  });
  res.json({ success: true, queueLength: commands.length });
});

// Fetch pending commands for an aircraft (polled by userscripts that predate
// receiving commands in the position response)
router.get("/:id", (req, res) => {
  res.json({ commands: takeQueuedCommands(req.params.id, "poll") });
});

module.exports = router;
