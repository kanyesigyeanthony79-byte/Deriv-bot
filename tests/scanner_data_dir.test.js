"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getDataDir } = require("../scanner_data_dir");

test("uses the application directory when no data directory is configured", () => {
  const appDir = path.join(os.tmpdir(), "deriv-scanner-default-test");
  assert.equal(getDataDir({}, appDir), appDir);
  assert.equal(fs.existsSync(appDir), true);
  fs.rmSync(appDir, { recursive: true, force: true });
});

test("creates and resolves a configured persistent data directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deriv-scanner-data-"));
  const configured = path.join(root, "runtime", "state");
  try {
    assert.equal(getDataDir({ SCANNER_DATA_DIR: configured }), configured);
    assert.equal(fs.statSync(configured).isDirectory(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignores an empty data-directory setting and preserves legacy behavior", () => {
  const appDir = path.join(os.tmpdir(), "deriv-scanner-empty-test");
  assert.equal(getDataDir({ SCANNER_DATA_DIR: "  " }, appDir), appDir);
  fs.rmSync(appDir, { recursive: true, force: true });
});
