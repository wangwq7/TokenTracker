const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  resolveCindyUserDataDirs,
  resolveCindyAgentHomes,
} = require("../src/lib/cindy-paths");

test("resolveCindyAgentHomes finds Cindy isolated agent homes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cindy-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cindyDir = path.join(root, "Cindy");
  const codexHome = path.join(cindyDir, "codex-home");
  const claudeHome = path.join(cindyDir, "claude-home");
  const piHome = path.join(cindyDir, "pi-agent-home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(piHome, { recursive: true });

  const options = {
    env: { APPDATA: root },
    home: path.join(root, "home"),
    platform: "win32",
  };
  assert.deepEqual(resolveCindyAgentHomes("codex", options), [fs.realpathSync(codexHome)]);
  assert.deepEqual(resolveCindyAgentHomes("claude", options), [fs.realpathSync(claudeHome)]);
  assert.deepEqual(resolveCindyAgentHomes("pi", options), [fs.realpathSync(piHome)]);
});

test("resolveCindyUserDataDirs honors explicit data dir and deduplicates aliases", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cindy-explicit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cindyDir = path.join(root, "CindyGlobal");
  fs.mkdirSync(cindyDir, { recursive: true });

  const result = resolveCindyUserDataDirs({
    env: {
      APPDATA: root,
      TOKENTRACKER_CINDY_DATA_DIR: cindyDir,
      XDT_USER_DATA_DIR: cindyDir,
    },
    home: path.join(root, "home"),
    platform: "win32",
  });
  assert.deepEqual(result, [fs.realpathSync(cindyDir)]);
});

test("resolveCindyUserDataDirs uses platform-specific defaults", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cindy-platform-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const macDir = path.join(root, "Library", "Application Support", "Cindy");
  const linuxDir = path.join(root, ".config", "CindyGlobal");
  fs.mkdirSync(macDir, { recursive: true });
  fs.mkdirSync(linuxDir, { recursive: true });

  assert.deepEqual(
    resolveCindyUserDataDirs({ env: {}, home: root, platform: "darwin" }),
    [fs.realpathSync(macDir)],
  );
  assert.deepEqual(
    resolveCindyUserDataDirs({ env: {}, home: root, platform: "linux" }),
    [fs.realpathSync(linuxDir)],
  );
});

test("synthetic HOME ignores host APPDATA and XDT user data", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cindy-isolated-home-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostData = path.join(root, "host", "Cindy");
  const isolatedData = path.join(root, "isolated", "AppData", "Roaming", "Cindy");
  fs.mkdirSync(hostData, { recursive: true });
  fs.mkdirSync(isolatedData, { recursive: true });

  const result = resolveCindyUserDataDirs({
    env: {
      HOME: path.join(root, "isolated"),
      USERPROFILE: path.join(root, "isolated"),
      APPDATA: path.join(root, "host"),
      XDT_USER_DATA_DIR: hostData,
    },
    platform: "win32",
  });
  assert.deepEqual(result, [fs.realpathSync(isolatedData)]);
});
