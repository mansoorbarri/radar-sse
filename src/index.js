require("dotenv").config();
const express = require("express");
const cors = require("cors");
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

app.use(cors({
  origin: [
    "https://www.geo-fs.com",
    "https://beta.geo-fs.com",
    "https://radarthing.com",
    "https://vstrips.xyzmani.com",
    "http://localhost:3000",
  ],
}));
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

async function startServer() {
  await restoreFlightSessionsFromConvex();
  await persistFlightSessionsToConvex("startup");

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
  await persistFlightSessionsToConvex(`shutdown:${signal}`, {
    throwOnError: true,
    waitForInFlight: true,
  });
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
