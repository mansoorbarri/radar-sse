function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return null;
}

function resolveDiscordUsername({ user, aircraft } = {}) {
  return firstNonEmptyString(
    aircraft?.discordUsername,
    aircraft?.discordGlobalName,
    aircraft?.username,
    aircraft?.user,
    user?.discordUsername,
    user?.discordGlobalName,
    user?.discordDisplayName,
    user?.discordName,
    user?.username,
    user?.name
  );
}

function resolveFlightCallsign(aircraft) {
  return firstNonEmptyString(
    aircraft?.flightNo,
    aircraft?.callsign
  );
}

function buildAircraftDisplayFields({ aircraft, user } = {}) {
  const discordUsername = resolveDiscordUsername({ user, aircraft });
  const flightCallsign = resolveFlightCallsign(aircraft);

  return {
    discordUsername,
    flightCallsign,
    displayName: flightCallsign || discordUsername || String(aircraft?.id || ""),
  };
}

function buildAuthLogIdentity({ aircraft, user, googleId } = {}) {
  const { discordUsername, flightCallsign } = buildAircraftDisplayFields({
    aircraft,
    user,
  });

  const parts = [];
  if (flightCallsign) {
    parts.push(`Callsign: ${flightCallsign}`);
  }
  if (discordUsername) {
    parts.push(`Discord: ${discordUsername}`);
  }
  if (parts.length === 0 && googleId) {
    parts.push(`GoogleID: ${googleId}`);
  }

  return parts.join(" | ");
}

function normalizeAirportController(controller) {
  const discordUsername = firstNonEmptyString(
    controller?.discordUsername,
    controller?.user
  );

  return {
    ...controller,
    discordUsername,
    displayName: discordUsername || controller?.position || "controller",
  };
}

function normalizeAirportEntry(entry) {
  if (!entry) return entry;

  return {
    ...entry,
    controllers: Array.isArray(entry.controllers)
      ? entry.controllers.map(normalizeAirportController)
      : [],
  };
}

module.exports = {
  buildAuthLogIdentity,
  buildAircraftDisplayFields,
  normalizeAirportController,
  normalizeAirportEntry,
};
