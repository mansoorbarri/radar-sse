const express = require("express");
const zlib = require("node:zlib");
const { addSubscriber, removeSubscriber } = require("../store");
const { sendFullState } = require("../services/broadcast");

const router = express.Router();

// Honor Accept-Encoding q-values: "gzip;q=0" means gzip is not acceptable.
function acceptsGzip(header) {
  if (!header) return false;
  let wildcard = false;
  for (const part of String(header).split(",")) {
    const [rawToken, ...params] = part.split(";");
    const token = rawToken.trim().toLowerCase();
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=").map((v) => v.trim());
      if (key.toLowerCase() === "q") q = Number(value);
    }
    const acceptable = Number.isFinite(q) && q > 0;
    if (token === "gzip" || token === "x-gzip") return acceptable;
    if (token === "*") wildcard = acceptable;
  }
  return wildcard;
}

router.get("/", (req, res) => {
  // Network egress is most of the hosting bill, and the repeated JSON keys in
  // each payload compress roughly 10x. One gzip stream per connection keeps
  // its dictionary across messages; a sync flush pushes out each event.
  const useGzip = acceptsGzip(req.headers["accept-encoding"]);

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

  // Broadcasts are deltas, so a slow client can't just drop some. While its
  // buffer is full, skip messages instead of queuing them without bound, then
  // resync with a full state snapshot once the stream drains.
  const writable = gzip || res;
  let lagging = false;
  let skipped = false;

  const send = (message) => {
    if (lagging) {
      skipped = true;
      return;
    }
    const ok = writable.write(`data: ${message}\n\n`);
    if (gzip) gzip.flush(zlib.constants.Z_SYNC_FLUSH);
    if (!ok) {
      lagging = true;
      writable.once("drain", () => {
        lagging = false;
        // Only resync if a delta was actually dropped, otherwise a snapshot
        // that fills the buffer by itself would resend forever.
        if (skipped) {
          skipped = false;
          sendFullState(send);
        }
      });
    }
  };

  // Send full state on initial connection
  sendFullState(send);

  const id = Date.now();
  addSubscriber({ id, send });

  res.on("close", () => {
    removeSubscriber(id);
    if (gzip) gzip.destroy();
  });
});

module.exports = router;
