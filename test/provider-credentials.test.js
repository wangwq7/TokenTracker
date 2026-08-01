const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  credentialsPath,
  deleteProviderCredentials,
  providerCredentialsSummary,
  readProviderCredentials,
  saveCodexAccounts,
  saveProviderCredentials,
  updateCodexAccountTokens,
} = require("../src/lib/provider-credentials");

function codexJwt(accountId, email, marker) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    exp: 4_102_444_800,
    marker,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: "team",
    },
    "https://api.openai.com/profile": { email },
  })).toString("base64url");
  return `${header}.${payload}.`;
}

function codexAccount(accountId, email, priority = 0, marker = "initial") {
  return {
    account_id: accountId,
    email,
    access_token: codexJwt(accountId, email, `access-${marker}`),
    id_token: codexJwt(accountId, email, `id-${marker}`),
    refresh_token: `refresh-${marker}-${accountId}`,
    last_refresh: "2026-08-01T00:00:00.000Z",
    priority,
  };
}

describe("provider credentials", () => {
  it("stores and masks DeepSeek and Volcengine secrets in TokenTracker's own file", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-provider-credentials-"));
    try {
      await saveProviderCredentials("deepseek", { api_key: "sk-deepseek-secret-1234" }, { home });
      await saveProviderCredentials("volcengine", {
        access_key_id: "AKLTexample12345678",
        secret_access_key: "volc-secret-value",
        region: "cn-beijing",
      }, { home });

      assert.deepEqual(readProviderCredentials({ home }), {
        deepseek: { api_key: "sk-deepseek-secret-1234" },
        volcengine: {
          access_key_id: "AKLTexample12345678",
          secret_access_key: "volc-secret-value",
          region: "cn-beijing",
        },
        codex: { accounts: [] },
      });
      const summary = providerCredentialsSummary({ home });
      assert.equal(summary.deepseek.configured, true);
      assert.equal(summary.deepseek.api_key_hint, "sk-••••1234");
      assert.equal(summary.volcengine.configured, true);
      assert.equal(summary.volcengine.secret_access_key_set, true);
      assert.equal(summary.volcengine.access_key_id_hint, "AKLT••••5678");
      assert.doesNotMatch(JSON.stringify(summary), /secret-value|deepseek-secret/);
      const filePath = credentialsPath({ home });
      assert.equal(fs.existsSync(filePath), true);
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
      }
      assert.deepEqual(
        fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith(".tmp")),
        [],
      );

      await deleteProviderCredentials("deepseek", { home });
      assert.equal(providerCredentialsSummary({ home }).deepseek.configured, false);
      assert.equal(providerCredentialsSummary({ home }).volcengine.configured, true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("persists concurrent Codex token refreshes without losing either account", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-credentials-race-"));
    const accountA = "account-a";
    const accountB = "account-b";
    try {
      await saveCodexAccounts([
        codexAccount(accountA, "alpha@example.com", 10),
        codexAccount(accountB, "bravo@example.com", 0),
      ], { home });

      const refreshedA = {
        access_token: codexJwt(accountA, "alpha@example.com", "access-refreshed-a"),
        id_token: codexJwt(accountA, "alpha@example.com", "id-refreshed-a"),
        refresh_token: "refresh-refreshed-a",
      };
      const refreshedB = {
        access_token: codexJwt(accountB, "bravo@example.com", "access-refreshed-b"),
        id_token: codexJwt(accountB, "bravo@example.com", "id-refreshed-b"),
        refresh_token: "refresh-refreshed-b",
      };

      await Promise.all([
        updateCodexAccountTokens(accountA, refreshedA, {
          home,
          lastRefresh: "2026-08-01T01:00:00.000Z",
        }),
        updateCodexAccountTokens(accountB, refreshedB, {
          home,
          lastRefresh: "2026-08-01T01:00:01.000Z",
        }),
      ]);

      const stored = readProviderCredentials({ home }).codex.accounts;
      assert.equal(stored.length, 2);
      assert.equal(stored.find((account) => account.account_id === accountA).access_token, refreshedA.access_token);
      assert.equal(stored.find((account) => account.account_id === accountB).access_token, refreshedB.access_token);
      assert.equal(stored.find((account) => account.account_id === accountA).refresh_token, refreshedA.refresh_token);
      assert.equal(stored.find((account) => account.account_id === accountB).refresh_token, refreshedB.refresh_token);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

});
