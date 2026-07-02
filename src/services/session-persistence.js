const { convex } = require("../db");
const {
  FLIGHT_SESSION_PERSIST_INTERVAL_MS,
} = require("../config");
const {
  flightSessions,
  disconnectedSessions,
  parkDisconnectedSession,
} = require("../store");
const { createLogger } = require("../utils/logger");

const log = createLogger("session-persistence");

let persistTimer = null;
let persistInFlight = false;

function getSystemSecretArgs() {
  return process.env.CONVEX_SYSTEM_SECRET
    ? { systemSecret: process.env.CONVEX_SYSTEM_SECRET }
    : {};
}

function serializeSession(session) {
  return {
    ...session,
    startTime:
      session.startTime instanceof Date
        ? session.startTime.toISOString()
        : session.startTime,
  };
}

function hydrateSession(session, userId) {
  const hydrated = {
    ...session,
    convexUserId: session.convexUserId || userId,
    startTime: new Date(session.startTime),
  };

  if (Number.isNaN(hydrated.startTime.getTime())) {
    hydrated.startTime = new Date();
  }

  return hydrated;
}

function getSessionDisconnectedAt(session, fallback = Date.now()) {
  const disconnectedAt = Math.max(
    Number(session?.lastCoordAt) || 0,
    Number(session?.endTime) || 0,
  );

  return disconnectedAt > 0 ? disconnectedAt : fallback;
}

function buildPersistedSessions() {
  const byUserId = new Map();

  for (const [aircraftId, session] of flightSessions) {
    if (!session?.convexUserId) continue;

    byUserId.set(session.convexUserId, {
      userId: session.convexUserId,
      state: "active",
      originalId: String(aircraftId),
      session: serializeSession(session),
      disconnectedAt: getSessionDisconnectedAt(session),
    });
  }

  for (const [userId, data] of disconnectedSessions) {
    if (!data?.session) continue;

    byUserId.set(userId, {
      userId,
      state: "disconnected",
      originalId: String(data.originalId || userId),
      session: serializeSession(data.session),
      disconnectedAt:
        Number(data.disconnectedAt) ||
        getSessionDisconnectedAt(data.session),
    });
  }

  return Array.from(byUserId.values());
}

async function persistFlightSessionsToConvex(reason = "interval") {
  if (persistInFlight) return;

  persistInFlight = true;
  try {
    const sessions = buildPersistedSessions();
    const result = await convex.mutation("activeFlightSessions:replaceAll", {
      sessions,
      ...getSystemSecretArgs(),
    });

    if (sessions.length > 0 || result.deleted > 0) {
      log.info("Checkpointed flight sessions to Convex", {
        reason,
        saved: result.saved,
        deleted: result.deleted,
      });
    }
  } catch (error) {
    log.error("Failed to checkpoint flight sessions to Convex", {
      reason,
      activeSessions: flightSessions.size,
      disconnectedSessions: disconnectedSessions.size,
      error,
    });
  } finally {
    persistInFlight = false;
  }
}

async function restoreFlightSessionsFromConvex() {
  try {
    const persistedSessions = await convex.query("activeFlightSessions:list", {
      ...getSystemSecretArgs(),
    });

    const restoredUserIds = [];
    for (const persisted of persistedSessions) {
      const session = hydrateSession(persisted.session, persisted.userId);
      const disconnectedAt =
        Number(persisted.disconnectedAt) ||
        getSessionDisconnectedAt(session, Number(persisted.updatedAt) || Date.now());

      session.endTime = getSessionDisconnectedAt(session, disconnectedAt);
      parkDisconnectedSession(
        session,
        persisted.originalId || persisted.userId,
        disconnectedAt,
      );
      restoredUserIds.push(persisted.userId);
    }

    if (restoredUserIds.length > 0) {
      log.info("Restored flight sessions from Convex", {
        restoredSessions: restoredUserIds.length,
      });

      await convex.mutation("activeFlightSessions:clear", {
        userIds: restoredUserIds,
        ...getSystemSecretArgs(),
      });
    }
  } catch (error) {
    log.error("Failed to restore flight sessions from Convex", {
      error,
    });
  }
}

function startFlightSessionPersistence() {
  if (persistTimer) return;

  persistTimer = setInterval(
    () => persistFlightSessionsToConvex("interval"),
    FLIGHT_SESSION_PERSIST_INTERVAL_MS,
  );
}

async function clearPersistedFlightSession(userId) {
  if (!userId) return;

  try {
    await convex.mutation("activeFlightSessions:clear", {
      userIds: [userId],
      ...getSystemSecretArgs(),
    });
  } catch (error) {
    log.error("Failed to clear persisted flight session", {
      userId,
      error,
    });
  }
}

module.exports = {
  clearPersistedFlightSession,
  persistFlightSessionsToConvex,
  restoreFlightSessionsFromConvex,
  startFlightSessionPersistence,
};
