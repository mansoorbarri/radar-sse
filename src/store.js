const fs = require("fs");
const path = require("path");

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

// Airports with online ATC: icao -> { icao, user, discordInvite, activatedAt }
const onlineAirports = new Map();

// ============================================================================
// PERSISTENCE - Survive restarts for online airports
// ============================================================================

const ATC_PERSIST_PATH = path.join(__dirname, "..", "data", "online-airports.json");
const FLIGHTS_PERSIST_PATH = path.join(__dirname, "..", "data", "flight-sessions.json");

function persistOnlineAirports() {
  try {
    const dir = path.dirname(ATC_PERSIST_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = Object.fromEntries(onlineAirports);
    fs.writeFileSync(ATC_PERSIST_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("[PERSIST] Failed to save online airports:", err.message);
  }
}

function restoreOnlineAirports() {
  try {
    if (!fs.existsSync(ATC_PERSIST_PATH)) return;
    const raw = fs.readFileSync(ATC_PERSIST_PATH, "utf-8");
    const data = JSON.parse(raw);
    for (const [icao, entry] of Object.entries(data)) {
      onlineAirports.set(icao, entry);
    }
    console.log(`[PERSIST] Restored ${onlineAirports.size} online airport(s)`);
  } catch (err) {
    console.error("[PERSIST] Failed to restore online airports:", err.message);
  }
}

function persistFlightSessions() {
  try {
    const dir = path.dirname(FLIGHTS_PERSIST_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const sessions = {};
    for (const [id, session] of flightSessions) {
      sessions[id] = {
        ...session,
        startTime: session.startTime instanceof Date ? session.startTime.toISOString() : session.startTime,
      };
    }

    const disconnected = {};
    for (const [userId, data] of disconnectedSessions) {
      disconnected[userId] = {
        ...data,
        session: {
          ...data.session,
          startTime: data.session.startTime instanceof Date ? data.session.startTime.toISOString() : data.session.startTime,
        },
      };
    }

    fs.writeFileSync(FLIGHTS_PERSIST_PATH, JSON.stringify({ sessions, disconnected }, null, 2));
    const total = Object.keys(sessions).length + Object.keys(disconnected).length;
    if (total > 0) {
      console.log(`[PERSIST] Saved ${Object.keys(sessions).length} active + ${Object.keys(disconnected).length} disconnected flight session(s)`);
    }
  } catch (err) {
    console.error("[PERSIST] Failed to save flight sessions:", err.message);
  }
}

function restoreFlightSessions() {
  try {
    if (!fs.existsSync(FLIGHTS_PERSIST_PATH)) return;
    const raw = fs.readFileSync(FLIGHTS_PERSIST_PATH, "utf-8");
    const data = JSON.parse(raw);

    if (data.sessions) {
      for (const [id, session] of Object.entries(data.sessions)) {
        session.startTime = new Date(session.startTime);
        // Move all previously active sessions into disconnectedSessions
        // so they can be reclaimed when the client reconnects with a new ID
        if (session.convexUserId) {
          disconnectedSessions.set(session.convexUserId, {
            session,
            originalId: id,
            disconnectedAt: Date.now(),
          });
        }
      }
    }

    if (data.disconnected) {
      for (const [userId, entry] of Object.entries(data.disconnected)) {
        entry.session.startTime = new Date(entry.session.startTime);
        // Reset the disconnect timer so the full grace period applies from restart
        entry.disconnectedAt = Date.now();
        disconnectedSessions.set(userId, entry);
      }
    }

    const total = disconnectedSessions.size;
    if (total > 0) {
      console.log(`[PERSIST] Restored ${total} flight session(s) into disconnected pool`);
    }

    // Clean up the persist file after restoring
    fs.unlinkSync(FLIGHTS_PERSIST_PATH);
  } catch (err) {
    console.error("[PERSIST] Failed to restore flight sessions:", err.message);
  }
}

// Restore on module load
restoreOnlineAirports();
restoreFlightSessions();

// ============================================================================
// CACHING LAYER - Reduces Convex function calls
// ============================================================================

// Cache duration constants
const USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for user lookups
const IMAGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes for image checks

// User cache: googleId -> { user, timestamp }
// Caches users:getByGoogleId results to avoid per-position-update queries
const userCache = new Map();

// Approved image cache: "airlineCode-aircraftType" -> { exists: boolean, timestamp }
// Caches aircraftImages:getApprovedImage results
const approvedImageCache = new Map();

/**
 * Get user from cache or return undefined if not cached/expired
 * @param {string} googleId
 * @returns {{ user: object | null, role: string, convexUserId: string | null } | undefined}
 */
function getCachedUser(googleId) {
  const cached = userCache.get(googleId);
  if (!cached) return undefined;
  if (Date.now() - cached.timestamp > USER_CACHE_TTL_MS) {
    userCache.delete(googleId);
    return undefined;
  }
  return cached;
}

/**
 * Store user in cache
 * @param {string} googleId
 * @param {object | null} user - The Convex user object or null if not found
 */
function setCachedUser(googleId, user) {
  userCache.set(googleId, {
    user,
    role: user?.role || "FREE",
    convexUserId: user?._id || null,
    timestamp: Date.now(),
  });
}

/**
 * Check if an approved image exists (from cache)
 * @param {string} airlineCode
 * @param {string} aircraftType
 * @returns {{ exists: boolean } | undefined} - undefined if not in cache
 */
function getCachedApprovedImage(airlineCode, aircraftType) {
  const key = `${airlineCode}-${aircraftType}`;
  const cached = approvedImageCache.get(key);
  if (!cached) return undefined;
  if (Date.now() - cached.timestamp > IMAGE_CACHE_TTL_MS) {
    approvedImageCache.delete(key);
    return undefined;
  }
  return { exists: cached.exists };
}

/**
 * Store approved image check result in cache
 * @param {string} airlineCode
 * @param {string} aircraftType
 * @param {boolean} exists
 */
function setCachedApprovedImage(airlineCode, aircraftType, exists) {
  const key = `${airlineCode}-${aircraftType}`;
  approvedImageCache.set(key, { exists, timestamp: Date.now() });
}

/**
 * Invalidate image cache for a combo (e.g., when an image is approved)
 * @param {string} airlineCode
 * @param {string} aircraftType
 */
function invalidateImageCache(airlineCode, aircraftType) {
  approvedImageCache.delete(`${airlineCode}-${aircraftType}`);
}

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
  onlineAirports,
  getSubscribers,
  addSubscriber,
  removeSubscriber,
  // User cache
  getCachedUser,
  setCachedUser,
  // Approved image cache
  getCachedApprovedImage,
  setCachedApprovedImage,
  invalidateImageCache,
  // Persistence
  persistOnlineAirports,
  persistFlightSessions,
};
