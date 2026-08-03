const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOST_HOME = os.homedir();

const CINDY_USER_DATA_DIR_NAMES = [
  "Cindy",
  "CindyGlobal",
  "CindyDev",
  "xdt-maker",
];

const CINDY_AGENT_HOME_NAMES = {
  codex: "codex-home",
  claude: "claude-home",
  pi: "pi-agent-home",
};

function normalizePathForCompare(filePath, platform = process.platform) {
  const resolved = path.resolve(filePath);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathIdentity(filePath, { platform = process.platform, deps = {} } = {}) {
  if (typeof filePath !== "string" || !filePath) return "";
  const realpathSync = deps.realpathSync || fssync.realpathSync;
  let canonical = filePath;
  try { canonical = realpathSync(filePath); } catch (_e) { }
  return normalizePathForCompare(canonical, platform);
}

function resolveExistingDirectory(candidate, deps = {}) {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const realpathSync = deps.realpathSync || fssync.realpathSync;
  const statSync = deps.statSync || fssync.statSync;
  try {
    const real = realpathSync(candidate);
    return statSync(real).isDirectory() ? real : null;
  } catch (_e) {
    return null;
  }
}

function uniqueExistingDirectories(candidates, { platform = process.platform, deps = {} } = {}) {
  const seen = new Set();
  const directories = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const real = resolveExistingDirectory(candidate, deps);
    if (!real) continue;
    const key = normalizePathForCompare(real, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    directories.push(real);
  }
  return directories;
}

function resolveCindyUserDataDirs({
  env = process.env,
  home,
  platform = process.platform,
  deps = {},
} = {}) {
  const resolvedHome = home || env.HOME || env.USERPROFILE || os.homedir();
  const envHome = env.HOME || env.USERPROFILE;
  const syntheticHome = Boolean(
    envHome && normalizePathForCompare(envHome, platform)
      !== normalizePathForCompare(HOST_HOME, platform),
  );
  if (env.TOKENTRACKER_CINDY_DATA_DIR) {
    return uniqueExistingDirectories([env.TOKENTRACKER_CINDY_DATA_DIR], { platform, deps });
  }
  const explicit = syntheticHome ? [] : [env.XDT_USER_DATA_DIR];
  let baseDir;
  if (platform === "darwin") {
    baseDir = path.join(resolvedHome, "Library", "Application Support");
  } else if (platform === "win32") {
    baseDir = !syntheticHome && env.APPDATA
      ? env.APPDATA
      : path.join(resolvedHome, "AppData", "Roaming");
  } else {
    baseDir = env.XDG_CONFIG_HOME || path.join(resolvedHome, ".config");
  }
  const defaults = CINDY_USER_DATA_DIR_NAMES.map((name) => path.join(baseDir, name));
  return uniqueExistingDirectories([...explicit, ...defaults], { platform, deps });
}

function resolveCindyAgentHomes(agent, options = {}) {
  const homeName = CINDY_AGENT_HOME_NAMES[agent];
  if (!homeName) return [];
  const platform = options.platform || process.platform;
  const candidates = resolveCindyUserDataDirs(options).map((dir) => path.join(dir, homeName));
  return uniqueExistingDirectories(candidates, { platform, deps: options.deps || {} });
}

module.exports = {
  CINDY_USER_DATA_DIR_NAMES,
  normalizePathForCompare,
  pathIdentity,
  uniqueExistingDirectories,
  resolveCindyUserDataDirs,
  resolveCindyAgentHomes,
};
