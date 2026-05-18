function normalizeSessionField(value) {
  if (typeof value !== "string") return "";

  const normalized = value.trim().toUpperCase();
  if (!normalized) return "";

  if (
    normalized === "???" ||
    normalized === "UNKNOWN" ||
    normalized === "N/A" ||
    normalized === "NONE" ||
    normalized === "NULL" ||
    normalized === "-"
  ) {
    return "";
  }

  return normalized;
}

function normalizeSessionTimestamp(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getSessionFlightIdentifier(sessionLike) {
  return normalizeSessionField(sessionLike?.flightNo || sessionLike?.callsign);
}

function getSessionDeparture(sessionLike) {
  return normalizeSessionField(sessionLike?.departure);
}

function getSessionArrival(sessionLike) {
  return normalizeSessionField(sessionLike?.arrival);
}

function getSessionTakeoffTime(sessionLike) {
  return normalizeSessionTimestamp(sessionLike?.takeoffTime);
}

function doSessionsLikelyMatch(sessionA, sessionB) {
  const takeoffA = getSessionTakeoffTime(sessionA);
  const takeoffB = getSessionTakeoffTime(sessionB);
  if (takeoffA && takeoffB) {
    return takeoffA === takeoffB;
  }

  const flightA = getSessionFlightIdentifier(sessionA);
  const flightB = getSessionFlightIdentifier(sessionB);
  if (!flightA || !flightB || flightA !== flightB) {
    return false;
  }

  const departureA = getSessionDeparture(sessionA);
  const departureB = getSessionDeparture(sessionB);
  if (departureA && departureB && departureA !== departureB) {
    return false;
  }

  const arrivalA = getSessionArrival(sessionA);
  const arrivalB = getSessionArrival(sessionB);
  if (arrivalA && arrivalB && arrivalA !== arrivalB) {
    return false;
  }

  return Boolean(
    takeoffA ||
      takeoffB ||
      departureA ||
      departureB ||
      arrivalA ||
      arrivalB ||
      flightA,
  );
}

module.exports = {
  normalizeSessionField,
  normalizeSessionTimestamp,
  getSessionFlightIdentifier,
  getSessionDeparture,
  getSessionArrival,
  getSessionTakeoffTime,
  doSessionsLikelyMatch,
};
