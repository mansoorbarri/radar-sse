const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());

app.use((err, req, res, next) => {
  if (err.type === "aborted") {
    return res.status(400).end();
  }
  next(err);
});

let aircraftMap = new Map();
let subscribers = [];

function broadcast() {
  const message = JSON.stringify({
    count: aircraftMap.size,
    aircraft: Array.from(aircraftMap.values()),
    timestamp: new Date().toISOString(),
  });
  subscribers.forEach((s) => s.res.write(`data: ${message}\n\n`));
}

app.post("/api/atc/position", (req, res) => {
  const data = req.body;
  if (data.id) {
    aircraftMap.set(data.id, {
      ...data,
      lastSeen: new Date().toISOString(),
      ts: Date.now(),
    });
    broadcast();
  }
  res.sendStatus(200);
});

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const initialMessage = JSON.stringify({
    count: aircraftMap.size,
    aircraft: Array.from(aircraftMap.values()),
    timestamp: new Date().toISOString(),
  });
  res.write(`data: ${initialMessage}\n\n`);

  const id = Date.now();
  const newSubscriber = { id, res };
  subscribers.push(newSubscriber);

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 3500);

  req.on("close", () => {
    clearInterval(heartbeat);
    subscribers = subscribers.filter((s) => s.id !== id);
  });
});

setInterval(() => {
  const now = Date.now();
  const timeout = 60000;
  let removedAny = false;

  for (const [id, aircraft] of aircraftMap.entries()) {
    if (now - (aircraft.ts || 0) > timeout) {
      aircraftMap.delete(id);
      removedAny = true;
    }
  }

  if (removedAny) {
    broadcast();
  }
}, 30000);

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => console.log(`Radar backend on port ${PORT}`));