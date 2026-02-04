const express = require("express");
const { addSubscriber, removeSubscriber } = require("../store");
const { sendFullState } = require("../services/broadcast");

const router = express.Router();

router.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Send full state on initial connection
  sendFullState(res);

  const id = Date.now();
  addSubscriber({ id, res });

  req.on("close", () => {
    removeSubscriber(id);
  });
});

module.exports = router;
