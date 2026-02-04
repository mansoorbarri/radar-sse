const express = require("express");
const { aircraftMap, addSubscriber, removeSubscriber } = require("../store");

const router = express.Router();

router.get("/", (req, res) => {
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
  addSubscriber({ id, res });

  req.on("close", () => {
    removeSubscriber(id);
  });
});

module.exports = router;
