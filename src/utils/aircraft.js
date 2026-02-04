// Extract airline code from callsign (e.g., "UAE123" -> "UAE", "EK456" -> "EK")
function extractAirlineCode(callsign) {
  if (!callsign) return null;
  const match = callsign.match(/^([A-Z]{2,3})/i);
  return match ? match[1].toUpperCase() : null;
}

// Normalize aircraft type from GeoFS format to DB format
// e.g., "Boeing 777-300ER" -> "B777", "Airbus A320" -> "A320"
function normalizeAircraftType(type) {
  if (!type) return null;
  const upper = type.toUpperCase();

  // Boeing: "BOEING 777-300ER" -> "B777"
  const boeingMatch = upper.match(/BOEING\s+(\d{3})/);
  if (boeingMatch) return `B${boeingMatch[1]}`;

  // Airbus: "AIRBUS A320" -> "A320"
  const airbusMatch = upper.match(/AIRBUS\s+(A\d{3})/);
  if (airbusMatch) return airbusMatch[1];

  // Already in short format (e.g., "B737", "A320")
  const shortMatch = upper.match(/^[AB]\d{3}$/);
  if (shortMatch) return upper;

  return null;
}

module.exports = {
  extractAirlineCode,
  normalizeAircraftType,
};
