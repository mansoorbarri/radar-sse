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
// stream egress. Subscribers that opt in (see routes/stream.js) only get an
// aircraft's flightPlan in a delta when it differs from what they last
// received, and keep the previous value when the key is absent. Everyone
// else still gets it every time, so tabs running older clients keep working.
const lastBroadcastFlightPlan = new Map();

// Clients may send the plan as an object or array, which is a new value on
// every request, so compare by content. Serializing strings too keeps a
// string and an object with the same JSON distinct. RadarThing stores
// aircraft by callsign, so a callsign change must resend the plan as well.
function flightPlanKey(aircraft) {
  return JSON.stringify([aircraft.callsign ?? null, aircraft.flightPlan ?? null]);
}

function withoutUnchangedFlightPlan(aircraft) {
  const key = flightPlanKey(aircraft);
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
    lastBroadcastFlightPlan.clear();
    clearTracking();
    return;
  }

  // Build delta message if we have tracked changes
  if (
    changedAircraft.size > 0 ||
    removedAircraft.size > 0 ||
    onlineAirportsChanged
  ) {
    const changed = [];
    for (const id of changedAircraft) {
      const aircraft = aircraftMap.get(id);
      if (aircraft) {
        changed.push(aircraft);
      }
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

    const hasLean = subscribers.some((s) => s.omitsUnchangedFlightPlans);
    const hasLegacy = subscribers.some((s) => !s.omitsUnchangedFlightPlans);
    let leanMessage;
    if (hasLean) {
      leanMessage = JSON.stringify({
        ...payload,
        aircraft: changed.map(withoutUnchangedFlightPlan),
      });
    } else {
      lastBroadcastFlightPlan.clear();
    }
    const legacyMessage = hasLegacy ? JSON.stringify(payload) : undefined;

    subscribers.forEach((s) =>
      s.send(s.omitsUnchangedFlightPlans ? leanMessage : legacyMessage),
    );
    clearTracking();
    return;
  }

  // Full update (fallback, shouldn't normally happen after init)
  const message = JSON.stringify({
    type: "full",
    count: aircraftMap.size,
    aircraft: Array.from(aircraftMap.values()),
    onlineAirports: Array.from(onlineAirports.values()),
    timestamp: new Date().toISOString(),
  });

  subscribers.forEach((s) => s.send(message));
  clearTracking();
}

function clearTracking() {
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
  // Forget the plan now: if the aircraft returns before the next broadcast,
  // subscribers that joined in between have no plan for it yet.
  lastBroadcastFlightPlan.delete(id);
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
      lastBroadcastFlightPlan.get(aircraft.id) !== flightPlanKey(aircraft)
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
