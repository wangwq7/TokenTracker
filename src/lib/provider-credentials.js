const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { chmod600IfPossible, ensureDir } = require("./fs");

const CREDENTIALS_FILE = "provider-credentials.json";
const PROVIDERS = new Set(["deepseek", "volcengine"]);
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";
const credentialMutationQueues = new Map();

function credentialsPath({ home = os.homedir() } = {}) {
  return path.join(home, ".tokentracker", "tracker", CREDENTIALS_FILE);
}

function normalizeString(value, maxLength = 4096) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function decodeJwtPayload(token) {
  const jwt = normalizeString(token, 65536);
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (_error) {
    return null;
  }
}

function openAiAuthClaims(payload) {
  const claims = payload?.[OPENAI_AUTH_CLAIM];
  return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : {};
}

function openAiProfileClaims(payload) {
  const claims = payload?.[OPENAI_PROFILE_CLAIM];
  return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : {};
}

function codexTokenIdentity(accessToken, idToken) {
  const accessPayload = decodeJwtPayload(accessToken);
  const idPayload = decodeJwtPayload(idToken);
  const accessAuth = openAiAuthClaims(accessPayload);
  const idAuth = openAiAuthClaims(idPayload);
  return {
    accessPayload,
    idPayload,
    accessAccountId: normalizeString(accessAuth.chatgpt_account_id, 256),
    idAccountId: normalizeString(idAuth.chatgpt_account_id, 256),
    email:
      normalizeString(openAiProfileClaims(accessPayload).email, 320) ||
      normalizeString(accessPayload?.email, 320) ||
      normalizeString(openAiProfileClaims(idPayload).email, 320) ||
      normalizeString(idPayload?.email, 320),
    planType:
      normalizeString(accessAuth.chatgpt_plan_type, 64).toLowerCase() ||
      normalizeString(idAuth.chatgpt_plan_type, 64).toLowerCase(),
  };
}

function normalizeCodexAccount(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const priorityValue = Number(source.priority);
  return {
    account_id: normalizeString(source.account_id, 256),
    email: normalizeString(source.email, 320),
    access_token: normalizeString(source.access_token, 65536),
    id_token: normalizeString(source.id_token, 65536),
    refresh_token: normalizeString(source.refresh_token, 65536),
    last_refresh: normalizeString(source.last_refresh, 128),
    disabled: source.disabled === true,
    priority: Number.isFinite(priorityValue) ? Math.trunc(priorityValue) : 0,
  };
}

function validateCodexAccount(raw) {
  const account = normalizeCodexAccount(raw);
  if (!account.account_id) throw new Error("Codex account_id is required");
  if (!account.access_token) throw new Error(`Codex access token is required for ${account.account_id}`);

  const identity = codexTokenIdentity(account.access_token, account.id_token);
  if (!identity.accessPayload || !identity.accessAccountId) {
    const error = new Error(`Codex access token is missing chatgpt_account_id for ${account.account_id}`);
    error.code = "CODEX_ACCOUNT_UNVERIFIED";
    throw error;
  }
  if (identity.accessAccountId !== account.account_id) {
    const error = new Error(`Codex access token account does not match ${account.account_id}`);
    error.code = "CODEX_ACCOUNT_MISMATCH";
    throw error;
  }
  if (account.id_token) {
    if (!identity.idPayload || !identity.idAccountId) {
      const error = new Error(`Codex ID token is missing chatgpt_account_id for ${account.account_id}`);
      error.code = "CODEX_ACCOUNT_UNVERIFIED";
      throw error;
    }
    if (identity.idAccountId !== account.account_id) {
      const error = new Error(`Codex ID token account does not match ${account.account_id}`);
      error.code = "CODEX_ACCOUNT_MISMATCH";
      throw error;
    }
  }

  return {
    ...account,
    email: identity.email || account.email,
  };
}

function normalizeStoredCredentials(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const deepseek = source.deepseek && typeof source.deepseek === "object" ? source.deepseek : {};
  const volcengine = source.volcengine && typeof source.volcengine === "object" ? source.volcengine : {};
  const codex = source.codex && typeof source.codex === "object" ? source.codex : {};
  const accounts = Array.isArray(codex.accounts)
    ? codex.accounts.map(normalizeCodexAccount).filter((account) => account.account_id || account.access_token)
    : [];
  return {
    deepseek: {
      api_key: normalizeString(deepseek.api_key),
    },
    volcengine: {
      access_key_id: normalizeString(volcengine.access_key_id),
      secret_access_key: normalizeString(volcengine.secret_access_key),
      region: normalizeString(volcengine.region, 128) || "cn-beijing",
    },
    codex: { accounts },
  };
}

function readProviderCredentials({ home = os.homedir() } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath({ home }), "utf8"));
    return normalizeStoredCredentials(raw);
  } catch (_error) {
    return normalizeStoredCredentials({});
  }
}

function readValidatedCodexAccounts({ home = os.homedir() } = {}) {
  const stored = readProviderCredentials({ home }).codex.accounts;
  return stored.map((account) => validateCodexAccount(account));
}

function maskSecret(value, { prefixLength = 4, suffixLength = 4 } = {}) {
  const text = normalizeString(value, 65536);
  if (!text) return null;
  if (text.length <= prefixLength + suffixLength) {
    return `${text.slice(0, 1)}••••${text.slice(-1)}`;
  }
  return `${text.slice(0, prefixLength)}••••${text.slice(-suffixLength)}`;
}

function maskEmail(value) {
  const email = normalizeString(value, 320);
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return maskSecret(email, { prefixLength: 1, suffixLength: 1 });
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const tail = local.length > 1 ? local.slice(-1) : "";
  return `${local.slice(0, 1)}••••${tail}@${domain}`;
}

function providerCredentialsSummary({ home = os.homedir() } = {}) {
  const credentials = readProviderCredentials({ home });
  const codexAccounts = credentials.codex.accounts.map((account) => {
    let identity = null;
    try {
      identity = codexTokenIdentity(account.access_token, account.id_token);
    } catch (_error) {}
    return {
      account_id_hint: maskSecret(account.account_id, { prefixLength: 8, suffixLength: 4 }),
      email_hint: maskEmail(identity?.email || account.email),
      plan_type: identity?.planType || null,
      disabled: account.disabled,
      priority: account.priority,
      has_refresh_token: Boolean(account.refresh_token),
    };
  });
  return {
    deepseek: {
      configured: Boolean(credentials.deepseek.api_key),
      api_key_hint: maskSecret(credentials.deepseek.api_key, { prefixLength: 3, suffixLength: 4 }),
    },
    volcengine: {
      configured: Boolean(
        credentials.volcengine.access_key_id && credentials.volcengine.secret_access_key,
      ),
      access_key_id_hint: maskSecret(credentials.volcengine.access_key_id),
      secret_access_key_set: Boolean(credentials.volcengine.secret_access_key),
      region: credentials.volcengine.region || "cn-beijing",
    },
    codex: {
      configured: codexAccounts.some((account) => !account.disabled),
      account_count: codexAccounts.filter((account) => !account.disabled).length,
      accounts: codexAccounts,
    },
  };
}

function validateProvider(provider) {
  const normalized = normalizeString(provider, 32).toLowerCase();
  if (!PROVIDERS.has(normalized)) {
    const error = new Error("Unknown provider credentials target");
    error.code = "UNKNOWN_PROVIDER";
    throw error;
  }
  return normalized;
}

async function writeCredentialsAtomic(filePath, credentials) {
  const directory = path.dirname(filePath);
  await ensureDir(directory);
  const suffix = crypto.randomBytes(8).toString("hex");
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${suffix}.tmp`);
  let handle = null;
  try {
    handle = await fsp.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tempPath, filePath);
    await chmod600IfPossible(filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function hasStoredCredentials(credentials) {
  return Boolean(
    credentials.deepseek.api_key ||
      credentials.volcengine.access_key_id ||
      credentials.volcengine.secret_access_key ||
      credentials.codex.accounts.length > 0,
  );
}

async function persistCredentials(credentials, { home = os.homedir() } = {}) {
  const normalized = normalizeStoredCredentials(credentials);
  const filePath = credentialsPath({ home });
  if (!hasStoredCredentials(normalized)) {
    await fsp.unlink(filePath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return;
  }
  await writeCredentialsAtomic(filePath, normalized);
}

function mutateCredentials(home, mutation) {
  const key = credentialsPath({ home });
  const previous = credentialMutationQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const current = readProviderCredentials({ home });
    const result = await mutation(current);
    await persistCredentials(current, { home });
    return result;
  });
  credentialMutationQueues.set(key, next);
  return next.finally(() => {
    if (credentialMutationQueues.get(key) === next) credentialMutationQueues.delete(key);
  });
}

async function saveProviderCredentials(provider, patch, { home = os.homedir() } = {}) {
  const id = validateProvider(provider);
  const input = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};

  await mutateCredentials(home, (current) => {
    if (id === "deepseek") {
      const apiKey = normalizeString(input.api_key);
      if (!apiKey) throw new Error("DeepSeek API key is required");
      current.deepseek = { api_key: apiKey };
    } else {
      const accessKeyId = normalizeString(input.access_key_id) || current.volcengine.access_key_id;
      const secretAccessKey = normalizeString(input.secret_access_key) || current.volcengine.secret_access_key;
      const region = normalizeString(input.region, 128) || current.volcengine.region || "cn-beijing";
      if (!accessKeyId || !secretAccessKey) {
        throw new Error("Volcengine AccessKey ID and Secret Access Key are required");
      }
      if (!/^[a-z]{2}-[a-z0-9-]+$/i.test(region)) {
        throw new Error("Volcengine region is invalid");
      }
      current.volcengine = {
        access_key_id: accessKeyId,
        secret_access_key: secretAccessKey,
        region,
      };
    }
  });
  return providerCredentialsSummary({ home });
}

async function saveCodexAccounts(accounts, { home = os.homedir() } = {}) {
  if (!Array.isArray(accounts)) throw new Error("Codex accounts must be an array");
  const byAccountId = new Map();
  for (const input of accounts) {
    const account = validateCodexAccount(input);
    byAccountId.set(account.account_id, account);
  }
  const normalizedAccounts = [...byAccountId.values()]
    .map((account, index) => ({ account, index }))
    .sort((a, b) => b.account.priority - a.account.priority || a.index - b.index)
    .map(({ account }) => account);
  await mutateCredentials(home, (current) => {
    current.codex = { accounts: normalizedAccounts };
  });
  return normalizedAccounts;
}

async function updateCodexAccountTokens(
  accountId,
  newTokens,
  { home = os.homedir(), lastRefresh = new Date().toISOString() } = {},
) {
  const id = normalizeString(accountId, 256);
  return mutateCredentials(home, (current) => {
    const index = current.codex.accounts.findIndex((account) => account.account_id === id);
    if (index < 0) throw new Error(`Unknown Codex account ${id}`);
    const existing = current.codex.accounts[index];
    const updated = validateCodexAccount({
      ...existing,
      access_token: newTokens?.access_token || existing.access_token,
      id_token: newTokens?.id_token || existing.id_token,
      refresh_token: newTokens?.refresh_token || existing.refresh_token,
      last_refresh: lastRefresh,
    });
    current.codex.accounts[index] = updated;
    return updated;
  });
}

async function deleteProviderCredentials(provider, { home = os.homedir() } = {}) {
  const id = validateProvider(provider);
  await mutateCredentials(home, (current) => {
    if (id === "deepseek") current.deepseek = { api_key: "" };
    else current.volcengine = { access_key_id: "", secret_access_key: "", region: "cn-beijing" };
  });
  return providerCredentialsSummary({ home });
}

module.exports = {
  CREDENTIALS_FILE,
  codexTokenIdentity,
  credentialsPath,
  deleteProviderCredentials,
  maskEmail,
  maskSecret,
  normalizeCodexAccount,
  normalizeStoredCredentials,
  providerCredentialsSummary,
  readProviderCredentials,
  readValidatedCodexAccounts,
  saveCodexAccounts,
  saveProviderCredentials,
  updateCodexAccountTokens,
  validateCodexAccount,
  writeCredentialsAtomic,
};
