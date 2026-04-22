const { ConvexHttpClient } = require("convex/browser");
const { createLogger } = require("./utils/logger");

const log = createLogger("db");

const convexUrl = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  log.error("Missing Convex URL environment variable", {
    requiredEnv: ["CONVEX_URL", "NEXT_PUBLIC_CONVEX_URL"],
  });
  process.exit(1);
}

const convex = new ConvexHttpClient(convexUrl);

module.exports = { convex };
