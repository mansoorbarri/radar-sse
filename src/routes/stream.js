const express = require("express");
const zlib = require("node:zlib");
const { addSubscriber, removeSubscriber } = require("../store");
const { sendFullState } = require("../services/broadcast");

const router = express.Router();

router.get("/", (req, res) => {
  // Network egress is most of the hosting bill, and the repeated JSON keys in
  // each payload compress roughly 10x. One gzip stream per connection keeps
  // its dictionary across messages; a sync flush pushes out each event.
  const useGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Vary", "Accept-Encoding");

  let gzip = null;
  if (useGzip) {
    res.setHeader("Content-Encoding", "gzip");
    gzip = zlib.createGzip();
    gzip.on("error", () => res.destroy());
    gzip.pipe(res);
  }

  const send = (message) => {
    const chunk = `data: ${message}\n\n`;
    if (gzip) {
      gzip.write(chunk);
      gzip.flush(zlib.constants.Z_SYNC_FLUSH);
    } else {
      res.write(chunk);
    }
  };

  // Send full state on initial connection
  sendFullState(send);

  const id = Date.now();
  addSubscriber({ id, send });

  req.on("close", () => {
    removeSubscriber(id);
    if (gzip) gzip.destroy();
  });
});

module.exports = router;
