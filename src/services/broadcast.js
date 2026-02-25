const { aircraftMap, onlineAirports, getSubscribers } = require("../store");

// Throttle settings
const BROADCAST_INTERVAL_MS = 500; // Max one broadcast per 500ms

let broadcastPending = false;
let _broadcastTimer = null; // Kept for potential future cancellation
let lastBroadcastTime = 0;

// Track changed aircraft since last broadcast for delta updates
const changedAircraft = new Set();
const removedAircraft = new Set();

function performBroadcast() {
  broadcastPending = false;
  _broadcastTimer = null;
  lastBroadcastTime = Date.now();

  const subscribers = getSubscribers();
  if (subscribers.length === 0) {
    // No subscribers, clear tracking
    changedAircraft.clear();
    removedAircraft.clear();
    return;
  }

  // Build delta message if we have tracked changes
  let message;
  if (changedAircraft.size > 0 || removedAircraft.size > 0) {
    const changed = [];
    for (const id of changedAircraft) {
      const aircraft = aircraftMap.get(id);
      if (aircraft) {
        changed.push(aircraft);
      }
    }

    message = JSON.stringify({
      type: "delta",
      count: aircraftMap.size,
      aircraft: changed,
      removed: Array.from(removedAircraft),
      onlineAirports: Array.from(onlineAirports.values()),
      timestamp: new Date().toISOString(),
    });
  } else {
    // Full update (fallback, shouldn't normally happen after init)
    message = JSON.stringify({
      type: "full",
      count: aircraftMap.size,
      aircraft: Array.from(aircraftMap.values()),
      onlineAirports: Array.from(onlineAirports.values()),
      timestamp: new Date().toISOString(),
    });
  }

  subscribers.forEach((s) => s.res.write(`data: ${message}\n\n`));

  // Clear tracking after broadcast
  changedAircraft.clear();
  removedAircraft.clear();
}

// Schedule a broadcast (throttled)
function broadcast() {
  if (broadcastPending) {
    return; // Already scheduled
  }

  const now = Date.now();
  const elapsed = now - lastBroadcastTime;

  if (elapsed >= BROADCAST_INTERVAL_MS) {
    // Enough time has passed, broadcast immediately
    performBroadcast();
  } else {
    // Schedule for later
    broadcastPending = true;
    const delay = BROADCAST_INTERVAL_MS - elapsed;
    _broadcastTimer = setTimeout(performBroadcast, delay);
  }
}

// Track aircraft changes for delta updates
function markAircraftChanged(id) {
  changedAircraft.add(id);
  removedAircraft.delete(id); // In case it was marked as removed
}

function markAircraftRemoved(id) {
  removedAircraft.add(id);
  changedAircraft.delete(id);
}

// Send full state to a new subscriber
function sendFullState(res) {
  const message = JSON.stringify({
    type: "full",
    count: aircraftMap.size,
    aircraft: Array.from(aircraftMap.values()),
    onlineAirports: Array.from(onlineAirports.values()),
    timestamp: new Date().toISOString(),
  });
  res.write(`data: ${message}\n\n`);
}

module.exports = {
  broadcast,
  markAircraftChanged,
  markAircraftRemoved,
  sendFullState,
};
