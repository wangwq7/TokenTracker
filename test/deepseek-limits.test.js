const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const { fetchDeepSeekBalance, normalizeDeepSeekBalance } = require("../src/lib/deepseek-limits");
const { saveProviderCredentials } = require("../src/lib/provider-credentials");

describe("DeepSeek balance limits", () => {
  it("normalizes official multi-currency balance responses", () => {
    assert.deepEqual(normalizeDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "12.34", granted_balance: "2", topped_up_balance: "10.34" },
        { currency: "USD", total_balance: 1.5, granted_balance: 0, topped_up_balance: 1.5 },
      ],
    }), {
      configured: true,
      error: null,
      available: true,
      balances: [
        { currency: "CNY", amount: 12.34, granted_balance: 2, topped_up_balance: 10.34 },
        { currency: "USD", amount: 1.5, granted_balance: 0, topped_up_balance: 1.5 },
      ],
    });
  });

  it("uses the locally stored API key without reading CC Switch state", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-deepseek-limits-"));
    try {
      await saveProviderCredentials("deepseek", { api_key: "sk-local-only" }, { home });
      const result = await fetchDeepSeekBalance({
        home,
        fetchImpl: async (url, options) => {
          assert.equal(url, "https://api.deepseek.com/user/balance");
          assert.equal(options.headers.Authorization, "Bearer sk-local-only");
          return {
            ok: true,
            status: 200,
            async json() {
              return { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "8.88" }] };
            },
          };
        },
      });
      assert.equal(result.configured, true);
      assert.equal(result.balances[0].amount, 8.88);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
