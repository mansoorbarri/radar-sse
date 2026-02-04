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

// Notified combos cache: Set<"airlineCode-aircraftType">
// Tracks combos we've already notified about (or checked notification exists)
// This prevents repeated missingImageNotifications:exists queries
const notifiedCombosCache = new Set();

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
 * Check if we've already processed this airline+aircraft combo for notifications
 * @param {string} airlineCode
 * @param {string} aircraftType
 * @returns {boolean}
 */
function hasNotifiedCombo(airlineCode, aircraftType) {
  return notifiedCombosCache.has(`${airlineCode}-${aircraftType}`);
}

/**
 * Mark a combo as notified/checked
 * @param {string} airlineCode
 * @param {string} aircraftType
 */
function markComboNotified(airlineCode, aircraftType) {
  notifiedCombosCache.add(`${airlineCode}-${aircraftType}`);
}

/**
 * Clear a combo from notified cache (e.g., when an image is approved)
 * @param {string} airlineCode
 * @param {string} aircraftType
 */
function clearNotifiedCombo(airlineCode, aircraftType) {
  notifiedCombosCache.delete(`${airlineCode}-${aircraftType}`);
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
  getSubscribers,
  addSubscriber,
  removeSubscriber,
  // User cache
  getCachedUser,
  setCachedUser,
  // Approved image cache
  getCachedApprovedImage,
  setCachedApprovedImage,
  // Notified combos cache
  hasNotifiedCombo,
  markComboNotified,
  clearNotifiedCombo,
  invalidateImageCache,
};
