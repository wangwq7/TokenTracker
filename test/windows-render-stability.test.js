const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("Windows host keeps WebView2 composition compatible with render protection", () => {
  const source = fs.readFileSync(path.join(root, "TokenTrackerWin", "Program.cs"), "utf8");
  const trayContext = source.indexOf("new TrayApplicationContext");

  assert.doesNotMatch(source, /RenderMode\.SoftwareOnly/);
  assert.ok(trayContext >= 0, "tray context should still be created");
  assert.match(source, /DispatcherUnhandledException/);
  assert.match(source, /0x88980406/);
  assert.match(source, /handled WPF render-thread failure/);
});
