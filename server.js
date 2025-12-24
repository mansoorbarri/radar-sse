const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());

// In-memory store for aircraft
let aircraftMap = new Map();
let subscribers = [];

// 1. RECEIVE DATA (From Tampermonkey)
app.post("/api/atc/position", (req, res) => {
  const data = req.body;
  
  // Update the map (ensure aircraft has an ID)
  if (data.id) {
    aircraftMap.set(data.id, {
      ...data,
      lastSeen: new Date().toISOString(),
    });

    // Broadcast update to all connected map users
    const message = JSON.stringify({
      count: aircraftMap.size,
      aircraft: Array.from(aircraftMap.values()),
      timestamp: new Date().toISOString(),
    });

    subscribers.forEach((s) => s.res.write(`data: ${message}\n\n`));
  }

  res.sendStatus(200);
});

// 2. STREAM DATA (To your Frontend Map)
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Send initial state
  const initialMessage = JSON.stringify({
    count: aircraftMap.size,
    aircraft: Array.from(aircraftMap.values()),
    timestamp: new Date().toISOString(),
  });
  res.write(`data: ${initialMessage}\n\n`);

  // Add user to subscribers list
  const id = Date.now();
  const newSubscriber = { id, res };
  subscribers.push(newSubscriber);

  // Heartbeat to prevent timeouts
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 3500);

  // Clean up on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    subscribers = subscribers.filter((s) => s.id !== id);
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Radar backend on port ${PORT}`));
