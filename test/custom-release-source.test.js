const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("native and dashboard update checks use the fork release source", () => {
  const updateChecker = read(
    "TokenTrackerBar/TokenTrackerBar/Services/UpdateChecker.swift",
  );
  const menuBarSection = read(
    "dashboard/src/components/settings/MenuBarSection.jsx",
  );
  const dashboardConfig = read("dashboard/src/lib/config.ts");

  assert.match(updateChecker, /repo = "wangwq7\/TokenTracker"/);
  assert.match(
    updateChecker,
    /releaseURL: String = "https:\/\/github\.com\/wangwq7\/TokenTracker\/releases\/latest"/,
  );
  assert.match(
    menuBarSection,
    /api\.github\.com\/repos\/wangwq7\/TokenTracker\/releases\/latest/,
  );
  assert.match(
    dashboardConfig,
    /REPO_URL = "https:\/\/github\.com\/wangwq7\/TokenTracker"/,
  );
});
