const { aircraftMap, onlineAirports, getSubscribers } = require("../store");
const { BROADCAST_INTERVAL_MS } = require("../config");

let broadcastPending = false;
let _broadcastTimer = null; // Kept for potential future cancellation
let lastBroadcastTime = 0;

// Track changed aircraft since last broadcast for delta updates
const changedAircraft = new Set();
const removedAircraft = new Set();
let onlineAirportsChanged = false;

// Flight plans are several KB of JSON each, rarely change, and were ~90% of
// stream egress. Deltas only carry an aircraft's flightPlan when it differs
// from what every subscriber last received; clients keep the previous value
// when the key is absent.
const lastBroadcastFlightPlan = new Map();

// Clients may send the plan as an object or array, which is a new value on
// every request, so compare by content. Serializing strings too keeps a
// string and an object with the same JSON distinct.
function flightPlanKey(flightPlan) {
  return JSON.stringify(flightPlan ?? null);
}

function withoutUnchangedFlightPlan(aircraft) {
  const key = flightPlanKey(aircraft.flightPlan);
  if (lastBroadcastFlightPlan.get(aircraft.id) === key) {
    const { flightPlan: _unchanged, ...rest } = aircraft;
    return rest;
  }
  lastBroadcastFlightPlan.set(aircraft.id, key);
  return { ...aircraft, flightPlan: aircraft.flightPlan ?? null };
}

function performBroadcast() {
  broadcastPending = false;
  _broadcastTimer = null;
  lastBroadcastTime = Date.now();

  const subscribers = getSubscribers();
  if (subscribers.length === 0) {
    // No subscribers, clear tracking
    changedAircraft.clear();
    lastBroadcastFlightPlan.clear();
    removedAircraft.clear();
    onlineAirportsChanged = false;
    return;
  }

  // Build delta message if we have tracked changes
  let message;
  if (
    changedAircraft.size > 0 ||
    removedAircraft.size > 0 ||
    onlineAirportsChanged
  ) {
    const changed = [];
    for (const id of changedAircraft) {
      const aircraft = aircraftMap.get(id);
      if (aircraft) {
        changed.push(withoutUnchangedFlightPlan(aircraft));
      }
    }
    for (const id of removedAircraft) {
      lastBroadcastFlightPlan.delete(id);
    }

    const payload = {
      type: "delta",
      count: aircraftMap.size,
      aircraft: changed,
      removed: Array.from(removedAircraft),
      timestamp: new Date().toISOString(),
    };

    if (onlineAirportsChanged) {
      payload.onlineAirports = Array.from(onlineAirports.values());
    }

    message = JSON.stringify(payload);
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

  subscribers.forEach((s) => s.send(message));

  // Clear tracking after broadcast
  changedAircraft.clear();
  removedAircraft.clear();
  onlineAirportsChanged = false;
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

function markOnlineAirportsChanged() {
  onlineAirportsChanged = true;
}

// Send full state to a new subscriber
function sendFullState(send) {
  // The snapshot may hold a flight plan that existing subscribers haven't
  // received yet. Forget it so the next delta sends it to everyone, keeping
  // all subscribers in agreement.
  for (const aircraft of aircraftMap.values()) {
    if (
      lastBroadcastFlightPlan.get(aircraft.id) !==
      flightPlanKey(aircraft.flightPlan)
    ) {
      lastBroadcastFlightPlan.delete(aircraft.id);
    }
  }
  const message = JSON.stringify({
    type: "full",
    count: aircraftMap.size,
    aircraft: Array.from(aircraftMap.values()),
    onlineAirports: Array.from(onlineAirports.values()),
    timestamp: new Date().toISOString(),
  });
  send(message);
}

module.exports = {
  broadcast,
  markAircraftChanged,
  markAircraftRemoved,
  markOnlineAirportsChanged,
  sendFullState,
};
