"use strict";
const fs = require("node:fs");
const path = require("node:path");

/**
 * Resolve the persistent runtime data directory.
 * Defaults to the application directory for backwards compatibility.
 */
function getDataDir(env = process.env, appDir = __dirname) {
  const configured = String(env.SCANNER_DATA_DIR || "").trim();
  const dataDir = configured ? path.resolve(configured) : appDir;
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

module.exports = { getDataDir };
