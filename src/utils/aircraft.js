// Extract airline code from callsign (e.g., "UAE123" -> "UAE", "EK456" -> "EK", "N489IF" -> "N")
function extractAirlineCode(callsign) {
  if (!callsign) return null;
  const upper = callsign.toUpperCase();
  // Detect N-numbers (US GA registration: N followed by digits)
  if (/^N\d/.test(upper)) return "N";
  const match = upper.match(/^([A-Z]{2,3})/);
  return match ? match[1] : null;
}

// Normalize aircraft type from GeoFS format to DB format
// e.g., "Boeing 777-300ER" -> "B777", "Airbus A320" -> "A320", "Piper PA-28" -> "PA28"
function normalizeAircraftType(type) {
  if (!type) return null;
  const upper = type.toUpperCase();

  const poseidonMatch = upper.match(/\bP-?8(?:I)?\b/);
  if (poseidonMatch) return "P8";

  // Boeing: "BOEING 777-300ER" -> "B777"
  const boeingMatch = upper.match(/BOEING\s+(\d{3})/);
  if (boeingMatch) return `B${boeingMatch[1]}`;

  // Airbus: "AIRBUS A320" -> "A320"
  const airbusMatch = upper.match(/AIRBUS\s+(A\d{3})/);
  if (airbusMatch) return airbusMatch[1];

  // Already in short format (e.g., "B737", "A320")
  const shortMatch = upper.match(/^[AB]\d{3}$/);
  if (shortMatch) return upper;

  // Antonov: "Antonov An-225 Mriya" -> "AN225"
  const antonovMatch = upper.match(/\bAN-?(\d{2,3})\b/);
  if (antonovMatch) return `AN${antonovMatch[1]}`;

  // GA: Piper "PA-28", "PA-44" -> "PA28", "PA44"
  const piperMatch = upper.match(/PA-?(\d{2,3})/);
  if (piperMatch) return `PA${piperMatch[1]}`;

  // GA: Cessna "172", "152" -> "C172", "C152"
  const cessnaMatch = upper.match(/\bCESSNA\s+(\d{3})/);
  if (cessnaMatch) return `C${cessnaMatch[1]}`;
  const cessnaShort = upper.match(/\bC(\d{3})\b/);
  if (cessnaShort) return `C${cessnaShort[1]}`;

  // GA: Cirrus "SR20", "SR22"
  const cirrusMatch = upper.match(/SR\d{2}/);
  if (cirrusMatch) return cirrusMatch[0];

  // GA: Diamond "DA40", "DA42", "DA62"
  const diamondMatch = upper.match(/DA\d{2}/);
  if (diamondMatch) return diamondMatch[0];

  // GA: Beechcraft "BE36", "BE58"
  const beechMatch = upper.match(/BE\d{2}/);
  if (beechMatch) return beechMatch[0];

  return null;
}

module.exports = {
  extractAirlineCode,
  normalizeAircraftType,
};
