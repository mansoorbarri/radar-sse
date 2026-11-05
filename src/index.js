require("dotenv").config();
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const { createLogger } = require("./utils/logger");

// Initialize DB connection (validates env vars)
require("./db");

// Import routes
const positionRouter = require("./routes/position");
const streamRouter = require("./routes/stream");
const commandsRouter = require("./routes/commands");
const flightsRouter = require("./routes/flights");
const { onlineRouter: airportsOnlineRouter, offlineRouter: airportsOfflineRouter } = require("./routes/airports");

// Import background tasks
const { startAllTasks } = require("./tasks/cleanup");
const { persistFlightSessions, persistOnlineAirports } = require("./store");
const {
  persistFlightSessionsToConvex,
  restoreFlightSessionsFromConvex,
  startFlightSessionPersistence,
} = require("./services/session-persistence");

const app = express();
const log = createLogger("server");

const allowedExactOrigins = new Set([
  "https://radarthing.com",
  "https://vstrips.xyzmani.com",
  "http://localhost:3000",
]);
const allowedOriginPatterns = [/^https?:\/\/([a-z0-9-]+\.)?geo-fs\.com$/i];

// Some browser extensions rewrite Origin with a trailing slash or different
// casing ("https://radarthing.com/"), which browsers never send themselves.
function normalizeOrigin(origin) {
  return String(origin).trim().replace(/\/+$/, "").toLowerCase();
}

function isAllowedCorsOrigin(origin) {
  return (
    allowedExactOrigins.has(origin) ||
    allowedOriginPatterns.some((pattern) => pattern.test(origin))
  );
}

app.use(cors({
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    // Echo the canonical origin: the browser checks the response against the
    // page's real origin, not the header an extension rewrote.
    const normalized = normalizeOrigin(origin);
    if (isAllowedCorsOrigin(normalized)) {
      callback(null, normalized);
      return;
    }

    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  // Let browsers reuse a preflight for 2 hours (Chrome's cap) instead of the
  // 5 second default, which preflighted most userscript position POSTs.
  maxAge: 7200,
}));

// Gzip JSON responses such as /api/active-flight-path. The SSE stream does its
// own gzip with per-event flushes, so keep this middleware off it entirely.
const compress = compression();
app.use((req, res, next) => {
  if (req.path.startsWith("/api/stream")) return next();
  return compress(req, res, next);
});
app.use(express.json());

// Mount routes
app.use("/api/atc/position", positionRouter);
app.use("/api/stream", streamRouter);
app.use("/api/command", commandsRouter);
app.use("/api/commands", commandsRouter);
app.use("/api", flightsRouter);
app.use("/api/airport-online", airportsOnlineRouter);
app.use("/api/airport-offline", airportsOfflineRouter);

const PORT = process.env.PORT || 3001;
const SHUTDOWN_PERSIST_TIMEOUT_MS = 10000;

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function startServer() {
  let restoredFromConvex = true;
  try {
    await restoreFlightSessionsFromConvex();
  } catch (error) {
    restoredFromConvex = false;
    log.error("Continuing startup after flight session restore failed", {
      error,
    });
  }

  if (restoredFromConvex) {
    await persistFlightSessionsToConvex("startup");
  }

  // Start background tasks after persisted sessions are restored.
  startAllTasks();
  startFlightSessionPersistence();

  app.listen(PORT, "0.0.0.0", () => {
    log.info("SSE server started", {
      port: PORT,
      host: "0.0.0.0",
      localUrl: `http://localhost:${PORT}`,
    });
  });
}

startServer().catch((error) => {
  log.error("Failed to start SSE server", {
    error,
  });
  process.exit(1);
});

// Graceful shutdown - persist in-memory state before exit
async function gracefulShutdown(signal) {
  log.info("Shutdown signal received; persisting state", {
    signal,
  });
  persistFlightSessions();
  persistOnlineAirports();
  await withTimeout(
    persistFlightSessionsToConvex(`shutdown:${signal}`, {
      throwOnError: true,
      waitForInFlight: true,
    }),
    SHUTDOWN_PERSIST_TIMEOUT_MS,
    `Timed out persisting flight sessions during ${signal}`,
  );
  log.info("State persisted; exiting", {
    signal,
  });
  process.exit(0);
}

process.on("SIGTERM", () => {
  gracefulShutdown("SIGTERM").catch((error) => {
    log.error("Shutdown persistence failed", {
      signal: "SIGTERM",
      error,
    });
    process.exit(1);
  });
});
process.on("SIGINT", () => {
  gracefulShutdown("SIGINT").catch((error) => {
    log.error("Shutdown persistence failed", {
      signal: "SIGINT",
      error,
    });
    process.exit(1);
  });
});
