const { convex } = require("../db");
const { extractAirlineCode, normalizeAircraftType } = require("../utils/aircraft");

// Check for missing aircraft image and record in Convex
async function checkAndNotifyMissingImage(flightNo, aircraftType) {
  if (!flightNo || !aircraftType) return;

  const airlineCode = extractAirlineCode(flightNo);
  if (!airlineCode) return;

  const normalizedType = normalizeAircraftType(aircraftType);
  if (!normalizedType) return; // Unknown aircraft type format

  try {
    // Check if we already have a record for this combo
    const alreadyNotified = await convex.query("missingImageNotifications:exists", {
      airlineCode: airlineCode,
      aircraftType: normalizedType,
    });

    if (alreadyNotified) return;

    // Check if approved image exists
    const image = await convex.query("aircraftImages:getApprovedImage", {
      airlineCode: airlineCode,
      aircraftType: normalizedType,
    });

    if (image) return; // Image exists, nothing to do

    // Create notification record for admin review
    await convex.mutation("missingImageNotifications:create", {
      airlineCode: airlineCode,
      aircraftType: normalizedType,
    });

    console.log(`[NOTIFY] Recorded missing image for ${airlineCode}-${normalizedType}`);
  } catch (e) {
    console.error("[NOTIFY] Error checking/recording notification:", e.message);
  }
}

module.exports = {
  checkAndNotifyMissingImage,
};
