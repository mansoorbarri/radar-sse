const { aircraftMap, getSubscribers } = require("../store");

function broadcast() {
  const message = JSON.stringify({
    count: aircraftMap.size,
    aircraft: Array.from(aircraftMap.values()),
    timestamp: new Date().toISOString(),
  });
  getSubscribers().forEach((s) => s.res.write(`data: ${message}\n\n`));
}

module.exports = {
  broadcast,
};
