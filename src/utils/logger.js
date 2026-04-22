const LEVEL_TO_CONSOLE_METHOD = {
  debug: "debug",
  info: "log",
  warn: "warn",
  error: "error",
};

function normalizeValue(value, seen = new WeakSet()) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, normalizeValue(entryValue, seen)]),
    );
  }

  return value;
}

function formatMeta(meta) {
  if (meta === undefined) return "";

  try {
    return ` ${JSON.stringify(normalizeValue(meta))}`;
  } catch (error) {
    return ` ${JSON.stringify({
      logSerializationError: error.message,
      meta: String(meta),
    })}`;
  }
}

function writeLog(level, scope, message, meta) {
  const method = LEVEL_TO_CONSOLE_METHOD[level] || "log";
  const line = [
    new Date().toISOString(),
    level.toUpperCase(),
    scope,
  ].map((part) => `[${part}]`).join(" ");

  console[method](`${line} ${message}${formatMeta(meta)}`);
}

function createLogger(scope) {
  return {
    debug(message, meta) {
      writeLog("debug", scope, message, meta);
    },
    info(message, meta) {
      writeLog("info", scope, message, meta);
    },
    warn(message, meta) {
      writeLog("warn", scope, message, meta);
    },
    error(message, meta) {
      writeLog("error", scope, message, meta);
    },
  };
}

module.exports = {
  createLogger,
};
