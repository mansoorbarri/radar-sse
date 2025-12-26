const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

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

app.post("/api/atc/position", async (req, res) => {
  const data = req.body;
  if (data.id) {
    let role = "FREE";
    let airlineLogo = null;

    if (data.googleId) {
      try {
        const user = await prisma.user.findUnique({
          where: { googleId: String(data.googleId) },
        });
        if (user) {
          role = user.role;
          airlineLogo = user.airlineLogo; // Optional
        }
      } catch (e) {
        console.error("DB Error:", e);
      }
    }

    aircraftMap.set(data.id, {
      ...data,
      role,
      airlineLogo,
      ts: Date.now(),
    });
    broadcast();
  }
  res.sendStatus(200);
});

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const initial = JSON.stringify({
    count: aircraftMap.size,
    aircraft: Array.from(aircraftMap.values()),
  });
  res.write(`data: ${initial}\n\n`);

  const id = Date.now();
  subscribers.push({ id, res });

  req.on("close", () => {
    subscribers = subscribers.filter((s) => s.id !== id);
  });
});

setInterval(() => {
  const now = Date.now();
  let removed = false;
  for (const [id, aircraft] of aircraftMap.entries()) {
    if (now - (aircraft.ts || 0) > 10000) {
      aircraftMap.delete(id);
      removed = true;
    }
  }
  if (removed) broadcast();
}, 5000);

app.listen(process.env.PORT || 3001, "0.0.0.0");