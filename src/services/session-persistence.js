const { randomUUID } = require("node:crypto");
const { convex } = require("../db");
const {
  FLIGHT_SESSION_PERSIST_INTERVAL_MS,
  FLIGHT_ROUTE_MAX_CHUNKS,
} = require("../config");
const {
  flightSessions,
  disconnectedSessions,
  parkDisconnectedSession,
} = require("../store");
const { createLogger } = require("../utils/logger");

const log = createLogger("session-persistence");

let persistTimer = null;
let persistInFlightPromise = null;

// What Convex already holds for each user's route, so checkpoints only send
// the coords added since. Positions push onto session.coords in place;
// downsampling and session merges assign a new array, which forces a resend.
const persistedRoutes = new Map();

function getSystemSecretArgs() {
  return process.env.CONVEX_SYSTEM_SECRET
    ? { systemSecret: process.env.CONVEX_SYSTEM_SECRET }
    : {};
}

function serializeSession(session) {
  const { coords: _coords, ...rest } = session;
  return {
    ...rest,
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

function buildRoute(userId, session) {
  const coords = Array.isArray(session.coords) ? session.coords : [];
  const previous = persistedRoutes.get(userId);
  const canAppend =
    previous &&
    previous.coordsRef === coords &&
    coords.length >= previous.count &&
    (previous.count === 0 ||
      coords[previous.count - 1] === previous.lastCoordRef) &&
    previous.chunks < FLIGHT_ROUTE_MAX_CHUNKS;

  const route = canAppend
    ? {
        version: previous.version,
        startIndex: previous.count,
        coords: coords.slice(previous.count),
      }
    : { version: randomUUID(), startIndex: 0, coords: coords.slice() };
  const count = route.startIndex + route.coords.length;
  const addedChunk = route.coords.length > 0 ? 1 : 0;

  return {
    route,
    // Applied only once Convex accepts the checkpoint.
    nextState: {
      version: route.version,
      coordsRef: coords,
      count,
      lastCoordRef: count > 0 ? coords[count - 1] : undefined,
      chunks: canAppend ? previous.chunks + addedChunk : addedChunk,
    },
  };
}

function buildPersistedSessions() {
  const byUserId = new Map();
  const nextRouteStates = new Map();

  const add = (userId, entry, session) => {
    const { route, nextState } = buildRoute(userId, session);
    byUserId.set(userId, { ...entry, route });
    nextRouteStates.set(userId, nextState);
  };

  for (const [aircraftId, session] of flightSessions) {
    if (!session?.convexUserId) continue;

    add(
      session.convexUserId,
      {
        userId: session.convexUserId,
        state: "active",
        originalId: String(aircraftId),
        session: serializeSession(session),
        disconnectedAt: getSessionDisconnectedAt(session),
      },
      session,
    );
  }

  for (const [userId, data] of disconnectedSessions) {
    if (!data?.session) continue;
    if (byUserId.has(userId)) continue;

    add(
      userId,
      {
        userId,
        state: "disconnected",
        originalId: String(data.originalId || userId),
        session: serializeSession(data.session),
        disconnectedAt:
          Number(data.disconnectedAt) ||
          getSessionDisconnectedAt(data.session),
      },
      data.session,
    );
  }

  return { sessions: Array.from(byUserId.values()), nextRouteStates };
}

function applyPersistedRouteStates(nextRouteStates, resyncUserIds = []) {
  const resync = new Set(resyncUserIds);
  persistedRoutes.clear();
  for (const [userId, state] of nextRouteStates) {
    if (!resync.has(userId)) persistedRoutes.set(userId, state);
  }
}

async function persistFlightSessionsToConvex(reason = "interval", options = {}) {
  const { throwOnError = false, waitForInFlight = false } = options;

  if (persistInFlightPromise) {
    if (!waitForInFlight) {
      return persistInFlightPromise.catch(() => {});
    }

    await persistInFlightPromise.catch(() => {});
  }

  const currentPersistPromise = (async () => {
    const { sessions, nextRouteStates } = buildPersistedSessions();
    const result = await convex.mutation("activeFlightSessions:replaceAll", {
      sessions,
      ...getSystemSecretArgs(),
    });
    applyPersistedRouteStates(nextRouteStates, result.resync);

    if (sessions.length > 0 || result.deleted > 0) {
      log.info("Checkpointed flight sessions to Convex", {
        reason,
        saved: result.saved,
        deleted: result.deleted,
        resync: result.resync?.length || 0,
      });
    }
  })();
  persistInFlightPromise = currentPersistPromise;

  try {
    await currentPersistPromise;
  } catch (error) {
    log.error("Failed to checkpoint flight sessions to Convex", {
      reason,
      activeSessions: flightSessions.size,
      disconnectedSessions: disconnectedSessions.size,
      error,
    });
    if (throwOnError) {
      throw error;
    }
  } finally {
    if (persistInFlightPromise === currentPersistPromise) {
      persistInFlightPromise = null;
    }
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
      if (persisted.routeVersion) {
        const coords = await convex.query("activeFlightSessions:getRoute", {
          userId: persisted.userId,
          ...getSystemSecretArgs(),
        });
        session.coords = Array.isArray(coords) ? coords : [];
      } else if (!Array.isArray(session.coords)) {
        session.coords = [];
      }
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
    throw error;
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
  persistedRoutes.delete(userId);

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
    throw error;
  }
}

module.exports = {
  clearPersistedFlightSession,
  persistFlightSessionsToConvex,
  restoreFlightSessionsFromConvex,
  startFlightSessionPersistence,
};
