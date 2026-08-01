const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  readProviderCredentials,
  saveCodexAccounts,
} = require("../src/lib/provider-credentials");
const {
  getUsageLimits,
  resetUsageLimitsCache,
} = require("../src/lib/usage-limits");

const WHAM_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const REFRESH_URL = "https://auth.openai.com/oauth/token";

function jwt({ accountId, email, marker, exp = 4_102_444_800 }) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    exp,
    marker,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: "team",
    },
    "https://api.openai.com/profile": { email },
  })).toString("base64url");
  return `${header}.${payload}.`;
}

function account(accountId, email, priority, marker = "initial", exp = 4_102_444_800) {
  return {
    account_id: accountId,
    email,
    access_token: jwt({ accountId, email, marker: `access-${marker}`, exp }),
    id_token: jwt({ accountId, email, marker: `id-${marker}`, exp }),
    refresh_token: `refresh-${marker}-${accountId}`,
    last_refresh: "2026-08-01T00:00:00.000Z",
    priority,
  };
}

function response(status, body = {}) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function usage(accountId, email, usedPercent) {
  return {
    account_id: accountId,
    email,
    plan_type: "team",
    rate_limit: {
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 18_000,
        reset_at: 2_000_000_000,
      },
      secondary_window: null,
    },
  };
}

function inactiveRunner() {
  return { status: 1, stdout: "" };
}

async function fetchLimits(home, fetchImpl) {
  resetUsageLimitsCache();
  return getUsageLimits({
    home,
    platform: "linux",
    providerTimeoutMs: 1_000,
    securityRunner: inactiveRunner,
    commandRunner: inactiveRunner,
    fetchImpl,
  });
}

function fallbackFetch(url) {
  if (url === RESET_URL) {
    return response(200, { available_count: null, total_earned_count: null, credits: [] });
  }
  return response(404, {});
}

describe("Codex official multi-account limits", () => {
  it("queries each configured account with its own account header and keeps quotas separate", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-multi-"));
    const accountA = "account-alpha";
    const accountB = "account-bravo";
    try {
      await saveCodexAccounts([
        account(accountA, "alpha@example.com", 10),
        account(accountB, "bravo@example.com", 0),
      ], { home });
      const requests = [];

      const result = await fetchLimits(home, (url, options = {}) => {
        if (url === WHAM_URL) {
          const accountId = options.headers?.["ChatGPT-Account-Id"];
          requests.push({
            accountId,
            userAgent: options.headers?.["User-Agent"],
          });
          if (accountId === accountA) return response(200, usage(accountA, "alpha@example.com", 11));
          if (accountId === accountB) return response(200, usage(accountB, "bravo@example.com", 73));
        }
        return fallbackFetch(url);
      });

      assert.deepEqual(requests.map((request) => request.accountId).sort(), [accountA, accountB]);
      assert.ok(requests.every((request) => request.userAgent === "codex-cli"));
      assert.equal(result.codex.accounts.length, 2);
      assert.equal(result.codex.accounts[0].account_id, accountA);
      assert.equal(result.codex.accounts[0].primary_window.used_percent, 11);
      assert.equal(result.codex.accounts[1].account_id, accountB);
      assert.equal(result.codex.accounts[1].primary_window.used_percent, 73);
      assert.equal(result.codex.account_id, accountA);
      assert.equal(result.codex.primary_window.used_percent, 11);
      assert.doesNotMatch(JSON.stringify(result.codex), /alpha@example\.com|bravo@example\.com/);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses only the matching account cache when one live request fails", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-cache-bound-"));
    const accountA = "account-cache-alpha";
    const accountB = "account-cache-bravo";
    try {
      await saveCodexAccounts([
        account(accountA, "alpha@example.com", 10),
        account(accountB, "bravo@example.com", 0),
      ], { home });

      await fetchLimits(home, (url, options = {}) => {
        if (url === WHAM_URL) {
          const accountId = options.headers?.["ChatGPT-Account-Id"];
          return response(200, usage(accountId, `${accountId}@example.com`, accountId === accountA ? 14 : 68));
        }
        return fallbackFetch(url);
      });

      const result = await fetchLimits(home, (url, options = {}) => {
        if (url === WHAM_URL) {
          const accountId = options.headers?.["ChatGPT-Account-Id"];
          if (accountId === accountA) return response(500, {});
          return response(200, usage(accountB, "bravo@example.com", 42));
        }
        return fallbackFetch(url);
      });

      const alpha = result.codex.accounts.find((item) => item.account_id === accountA);
      const bravo = result.codex.accounts.find((item) => item.account_id === accountB);
      assert.equal(alpha.error, null);
      assert.equal(alpha.stale, true);
      assert.equal(alpha.primary_window.used_percent, 14);
      assert.equal(bravo.error, null);
      assert.equal(bravo.stale, false);
      assert.equal(bravo.primary_window.used_percent, 42);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a mismatched response account instead of displaying or caching it", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-mismatch-"));
    const accountA = "account-mismatch-alpha";
    const accountB = "account-mismatch-bravo";
    try {
      await saveCodexAccounts([
        account(accountA, "alpha@example.com", 10),
        account(accountB, "bravo@example.com", 0),
      ], { home });

      await fetchLimits(home, (url, options = {}) => {
        if (url === WHAM_URL) {
          const accountId = options.headers?.["ChatGPT-Account-Id"];
          return response(200, usage(accountId, `${accountId}@example.com`, accountId === accountA ? 17 : 71));
        }
        return fallbackFetch(url);
      });

      const result = await fetchLimits(home, (url, options = {}) => {
        if (url === WHAM_URL) {
          const accountId = options.headers?.["ChatGPT-Account-Id"];
          if (accountId === accountA) return response(200, usage(accountB, "bravo@example.com", 99));
          return response(200, usage(accountB, "bravo@example.com", 33));
        }
        return fallbackFetch(url);
      });

      const alpha = result.codex.accounts.find((item) => item.account_id === accountA);
      const bravo = result.codex.accounts.find((item) => item.account_id === accountB);
      assert.match(alpha.error, /does not match/);
      assert.equal(alpha.primary_window, undefined);
      assert.equal(bravo.error, null);
      assert.equal(bravo.primary_window.used_percent, 33);

      const cachePath = path.join(home, ".tokentracker", "tracker", "codex-usage-limits-cache.json");
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      const cachedAlpha = cached.accounts.find((item) => item.account_id === accountA);
      assert.equal(cachedAlpha.primary_window.used_percent, 17);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not use an old unbound cache for explicit accounts", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-no-unbound-cache-"));
    const accountId = "account-explicit";
    try {
      await saveCodexAccounts([account(accountId, "explicit@example.com", 0)], { home });
      const trackerDir = path.join(home, ".tokentracker", "tracker");
      fs.mkdirSync(trackerDir, { recursive: true });
      fs.writeFileSync(path.join(trackerDir, "codex-usage-limits-cache.json"), JSON.stringify({
        codex: {
          primary_window: { used_percent: 88, reset_at: 2_000_000_000 },
          cached_at: new Date().toISOString(),
        },
      }));

      const result = await fetchLimits(home, (url) => {
        if (url === WHAM_URL) return response(500, {});
        return fallbackFetch(url);
      });

      assert.equal(result.codex.accounts.length, 1);
      assert.match(result.codex.accounts[0].error, /Codex API returned 500/);
      assert.equal(result.codex.accounts[0].primary_window, undefined);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("marks only the configured account with rejected refresh credentials for reauthentication", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-reauth-one-"));
    const accountA = "account-reauth-alpha";
    const accountB = "account-reauth-bravo";
    const expired = 1_600_000_000;
    try {
      await saveCodexAccounts([
        account(accountA, "alpha@example.com", 10, "expired", expired),
        account(accountB, "bravo@example.com", 0),
      ], { home });

      const result = await fetchLimits(home, (url, options = {}) => {
        if (url === REFRESH_URL) {
          return response(401, { error: { code: "refresh_token_expired" } });
        }
        if (url === WHAM_URL) {
          const accountId = options.headers?.["ChatGPT-Account-Id"];
          if (accountId === accountA) return response(401, {});
          if (accountId === accountB) return response(200, usage(accountB, "bravo@example.com", 42));
        }
        return fallbackFetch(url);
      });

      const alpha = result.codex.accounts.find((item) => item.account_id === accountA);
      const bravo = result.codex.accounts.find((item) => item.account_id === accountB);
      assert.equal(alpha.auth_action_required, "reauth");
      assert.match(alpha.error, /Run `codex login` to re-authenticate/);
      assert.equal(alpha.primary_window, undefined);
      assert.equal(bravo.error, null);
      assert.equal(bravo.primary_window.used_percent, 42);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the official auth.json single-account fallback when no account list is configured", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-legacy-auth-"));
    const accountId = "account-legacy";
    const email = "legacy@example.com";
    try {
      const codexDir = path.join(home, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({
        tokens: {
          access_token: jwt({ accountId, email, marker: "legacy-access" }),
          id_token: jwt({ accountId, email, marker: "legacy-id" }),
          refresh_token: "legacy-refresh",
          account_id: accountId,
        },
        last_refresh: "2026-08-01T00:00:00.000Z",
      }));

      const result = await fetchLimits(home, (url, options = {}) => {
        if (url === WHAM_URL) {
          assert.equal(options.headers?.["ChatGPT-Account-Id"], accountId);
          return response(200, {
            plan_type: "team",
            rate_limit: usage(accountId, email, 29).rate_limit,
          });
        }
        return fallbackFetch(url);
      });

      assert.equal(result.codex.configured, true);
      assert.equal(result.codex.error, null);
      assert.equal(result.codex.primary_window.used_percent, 29);
      assert.equal(result.codex.accounts.length, 1);
      assert.equal(readProviderCredentials({ home }).codex.accounts.length, 0);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refreshes and persists both configured accounts without overwriting either result", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-refresh-both-"));
    const accountA = "account-refresh-alpha";
    const accountB = "account-refresh-bravo";
    const expired = 1_600_000_000;
    try {
      await saveCodexAccounts([
        account(accountA, "alpha@example.com", 10, "expired-a", expired),
        account(accountB, "bravo@example.com", 0, "expired-b", expired),
      ], { home });

      const refreshedTokens = new Map();
      const result = await fetchLimits(home, (url, options = {}) => {
        if (url === REFRESH_URL) {
          const refreshToken = JSON.parse(options.body).refresh_token;
          const accountId = refreshToken.endsWith(accountA) ? accountA : accountB;
          const email = accountId === accountA ? "alpha@example.com" : "bravo@example.com";
          const tokens = {
            access_token: jwt({ accountId, email, marker: `refreshed-access-${accountId}` }),
            id_token: jwt({ accountId, email, marker: `refreshed-id-${accountId}` }),
            refresh_token: `rotated-${accountId}`,
          };
          refreshedTokens.set(accountId, tokens);
          return response(200, tokens);
        }
        if (url === WHAM_URL) {
          const accountId = options.headers?.["ChatGPT-Account-Id"];
          assert.equal(options.headers?.Authorization, `Bearer ${refreshedTokens.get(accountId).access_token}`);
          return response(200, usage(accountId, `${accountId}@example.com`, accountId === accountA ? 19 : 64));
        }
        return fallbackFetch(url);
      });

      assert.equal(result.codex.accounts.length, 2);
      const stored = readProviderCredentials({ home }).codex.accounts;
      assert.equal(stored.find((item) => item.account_id === accountA).access_token, refreshedTokens.get(accountA).access_token);
      assert.equal(stored.find((item) => item.account_id === accountB).access_token, refreshedTokens.get(accountB).access_token);
      assert.equal(stored.find((item) => item.account_id === accountA).refresh_token, `rotated-${accountA}`);
      assert.equal(stored.find((item) => item.account_id === accountB).refresh_token, `rotated-${accountB}`);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
