const { commandQueue } = require("../store");
const { createLogger } = require("../utils/logger");

const log = createLogger("commands");

// Remove and return an aircraft's queued commands so each is delivered once.
function takeQueuedCommands(id, via) {
  const commands = commandQueue.get(id) || [];

  if (commands.length > 0) {
    commandQueue.delete(id);
    log.info("Delivered queued aircraft commands", {
      aircraftId: id,
      via,
      deliveredCommands: commands.length,
      commandTypes: commands.map((command) => command.type),
    });
  }

  return commands;
}

module.exports = { takeQueuedCommands };
