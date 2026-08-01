const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");
function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("macOS limits model decodes Volcengine quota details and DeepSeek balances", () => {
  const model = read("TokenTrackerBar/TokenTrackerBar/Models/UsageLimits.swift");
  assert.match(model, /let volcengine: VolcengineLimits\?/);
  assert.match(model, /let deepseek: DeepSeekLimits\?/);
  assert.match(model, /struct GenericLimitWindow[\s\S]*let remainingCredits: Double\?[\s\S]*let unit: String\?/);
  assert.match(model, /struct DeepSeekBalance[\s\S]*let amount: Double[\s\S]*case toppedUpBalance = "topped_up_balance"/);
  assert.match(model, /\(volcengine\?\.configured \?\? false, volcengine\?\.error\)/);
  assert.match(model, /\(deepseek\?\.configured \?\? false, deepseek\?\.error\)/);
});

test("macOS native limits UI uses bars for Volcengine and balance rows for DeepSeek", () => {
  const view = read("TokenTrackerBar/TokenTrackerBar/Views/UsageLimitsView.swift");
  assert.match(view, /case "volcengine"[\s\S]*toolSection\([^\n]*volcengineSpecs/);
  assert.match(view, /private func volcengineQuotaDetail[\s\S]*remainingCredits/);
  assert.match(view, /case "deepseek"[\s\S]*deepSeekBalanceSection/);
  assert.match(view, /private func deepSeekBalanceSection/);
  const deepSeekSection = view.match(/private func deepSeekBalanceSection[\s\S]*?private func formatCurrencyAmount/);
  assert.ok(deepSeekSection, "DeepSeek balance section should be present");
  assert.doesNotMatch(deepSeekSection[0], /UsageLimitBar\(/);
  assert.match(view, /case "VolcengineLogo": return "volcengine\.svg"/);
  assert.match(view, /case "DeepSeekLogo": return "deepseek\.svg"/);
});

test("macOS widget and reset detector include only percentage-based Volcengine windows", () => {
  const resetDetector = read("TokenTrackerBar/TokenTrackerBar/Models/WeeklyLimitResetDetector.swift");
  assert.match(resetDetector, /addGeneric\("volcengine"[\s\S]*volcengine\.tertiaryWindow/);
  assert.doesNotMatch(resetDetector, /addGeneric\("deepseek"/);
  assert.match(resetDetector, /case "volcengine": return "volcengine\.svg"/);

  const widget = read("TokenTrackerBar/TokenTrackerBar/Services/WidgetSnapshotWriter.swift");
  assert.match(widget, /LimitProvider\(source: "volcengine", label: "Volcengine · 5h"/);
  assert.match(widget, /LimitProvider\(source: "volcengine", label: "Volcengine · monthly"/);
  assert.doesNotMatch(widget, /LimitProvider\(source: "deepseek"/);
});

test("macOS menu bar and Dynamic Island expose Volcengine windows but not DeepSeek balance", () => {
  const preferences = read("TokenTrackerBar/TokenTrackerBar/Models/MenuBarDisplayPreferences.swift");
  for (const metric of ["volcengine5h", "volcengineWeekly", "volcengineMonthly"]) {
    assert.match(preferences, new RegExp(`case ${metric}`));
  }
  assert.match(preferences, /case \.volcengine5h, \.volcengineWeekly, \.volcengineMonthly: return "volcengine"/);
  assert.doesNotMatch(preferences, /case deepseekBalance/);

  const model = read("TokenTrackerBar/TokenTrackerBar/Models/UsageLimits.swift");
  assert.match(model, /case \.volcengine5h:[\s\S]*volcengine\?\.primaryWindow\?\.usedPercent/);
  assert.match(model, /case \.volcengineWeekly:[\s\S]*volcengine\?\.secondaryWindow\?\.usedPercent/);
  assert.match(model, /case \.volcengineMonthly:[\s\S]*volcengine\?\.tertiaryWindow\?\.usedPercent/);

  const menuBar = read("TokenTrackerBar/TokenTrackerBar/Services/StatusBarController.swift");
  assert.match(menuBar, /case \.volcengine5h:[\s\S]*volcengine\?\.primaryWindow/);
  assert.match(menuBar, /case \.volcengineWeekly:[\s\S]*volcengine\?\.secondaryWindow/);
  assert.match(menuBar, /case \.volcengineMonthly:[\s\S]*volcengine\?\.tertiaryWindow/);

  const island = read("TokenTrackerBar/TokenTrackerBar/Views/DynamicIslandView.swift");
  assert.match(island, /\.volcengine5h/);
  assert.match(island, /\.volcengineWeekly/);
  assert.match(island, /\.volcengineMonthly/);
});
