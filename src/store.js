// In-memory data stores

// Current aircraft positions: id -> aircraft_data
const aircraftMap = new Map();

// SSE client connections: Array<{id, res}>
let subscribers = [];

// Active flight recordings: id -> session
const flightSessions = new Map();

// Pending remote commands per aircraft: id -> [commands]
const commandQueue = new Map();

// Sessions in grace period awaiting reconnection: convexUserId -> { session, originalId, disconnectedAt }
const disconnectedSessions = new Map();

// Subscriber management
function getSubscribers() {
  return subscribers;
}

function addSubscriber(subscriber) {
  subscribers.push(subscriber);
}

function removeSubscriber(id) {
  subscribers = subscribers.filter((s) => s.id !== id);
}

module.exports = {
  aircraftMap,
  flightSessions,
  commandQueue,
  disconnectedSessions,
  getSubscribers,
  addSubscriber,
  removeSubscriber,
};
