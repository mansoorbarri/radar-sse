const { convex } = require("../db");
const { extractAirlineCode, normalizeAircraftType } = require("../utils/aircraft");
const {
  getCachedApprovedImage,
  setCachedApprovedImage,
  hasNotifiedCombo,
  markComboNotified,
} = require("../store");

async function sendDiscordMissingImageNotification({
  airlineCode,
  aircraftType,
  callsign,
  flightNo,
}) {
  const webhookUrl = process.env.DISCORD_MISSING_IMAGE_WEBHOOK;
  if (!webhookUrl) return;

  try {
    const callsignText = callsign?.trim() || flightNo?.trim() || "Unknown";
    const aircraftText = `${airlineCode.toUpperCase()} ${aircraftType.toUpperCase()}`;

    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: `Missing aircraft image requested.\nAircraft: ${aircraftText}\nCallsign: ${callsignText}`,
      }),
    });
  } catch (e) {
    console.error("[NOTIFY] Discord webhook failed:", e.message);
  }
}

// Check for missing aircraft image and record in Convex
async function checkAndNotifyMissingImage(flightNo, aircraftType, callsign) {
  if (!flightNo || !aircraftType) return;

  const airlineCode = extractAirlineCode(flightNo);
  if (!airlineCode) return;

  const normalizedType = normalizeAircraftType(aircraftType);
  if (!normalizedType) return; // Unknown aircraft type format

  // Quick check: if we've already processed this combo, skip entirely
  // This prevents ALL Convex queries for repeated position updates
  if (hasNotifiedCombo(airlineCode, normalizedType)) {
    return;
  }

  // Check approved image cache before hitting Convex
  const cachedImage = getCachedApprovedImage(airlineCode, normalizedType);
  if (cachedImage?.exists) {
    // Image exists in cache - mark as processed and skip
    markComboNotified(airlineCode, normalizedType);
    return;
  }

  try {
    // Cache miss for image - query Convex
    if (!cachedImage) {
      const image = await convex.query("aircraftImages:getApprovedImage", {
        airlineCode: airlineCode,
        aircraftType: normalizedType,
      });

      // Cache the result
      setCachedApprovedImage(airlineCode, normalizedType, image !== null);

      if (image) {
        // Image exists - mark combo as processed
        markComboNotified(airlineCode, normalizedType);
        return;
      }
    }

    // No approved image - check if we already notified (query Convex)
    const alreadyNotified = await convex.query("missingImageNotifications:exists", {
      airlineCode: airlineCode,
      aircraftType: normalizedType,
    });

    if (alreadyNotified) {
      // Already notified - mark combo as processed to skip future checks
      markComboNotified(airlineCode, normalizedType);
      return;
    }

    // Create notification record for admin review
    const createResult = await convex.mutation("missingImageNotifications:create", {
      airlineCode: airlineCode,
      aircraftType: normalizedType,
    });

    // Send Discord alert only if this request actually created a new DB record
    if (createResult?.created) {
      await sendDiscordMissingImageNotification({
        airlineCode,
        aircraftType: normalizedType,
        callsign,
        flightNo,
      });

      console.log(`[NOTIFY] Recorded missing image for ${airlineCode}-${normalizedType}`);
    }

    // Mark as notified so we don't check again
    markComboNotified(airlineCode, normalizedType);
  } catch (e) {
    console.error("[NOTIFY] Error checking/recording notification:", e.message);
  }
}

module.exports = {
  checkAndNotifyMissingImage,
};
