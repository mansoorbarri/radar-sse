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

// Start background tasks
startAllTasks();

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  log.info("SSE server started", {
    port: PORT,
    host: "0.0.0.0",
    localUrl: `http://localhost:${PORT}`,
  });
});

// Graceful shutdown - persist in-memory state before exit
function gracefulShutdown(signal) {
  log.info("Shutdown signal received; persisting state", {
    signal,
  });
  persistFlightSessions();
  persistOnlineAirports();
  log.info("State persisted; exiting", {
    signal,
  });
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
