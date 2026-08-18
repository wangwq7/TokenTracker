const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("Windows host protects the tray from WPF render-thread failures", () => {
  const source = fs.readFileSync(path.join(root, "TokenTrackerWin", "Program.cs"), "utf8");
  const renderMode = source.indexOf("RenderOptions.ProcessRenderMode");
  const trayContext = source.indexOf("new TrayApplicationContext");

  assert.ok(renderMode >= 0, "WPF render mode should be configured");
  assert.ok(source.includes("RenderMode.SoftwareOnly"));
  assert.ok(renderMode < trayContext, "render mode must be set before WPF windows are created");
  assert.match(source, /DispatcherUnhandledException/);
  assert.match(source, /0x88980406/);
  assert.match(source, /handled WPF render-thread failure/);
});
