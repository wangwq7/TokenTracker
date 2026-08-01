const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const { saveProviderCredentials } = require("../src/lib/provider-credentials");
const {
  canonicalQuery,
  fetchVolcengineLimits,
  parseAgentPlanWindows,
  parseCodingPlanWindows,
  signVolcengineRequest,
} = require("../src/lib/volcengine-limits");

describe("Volcengine Agent Plan limits", () => {
  it("builds the canonical OpenAPI query and deterministic V4 authorization", () => {
    assert.equal(
      canonicalQuery("GetAFPUsage", "cn-beijing"),
      "Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01",
    );
    const signed = signVolcengineRequest({
      accessKeyId: "AKLTtest",
      secretAccessKey: "secretkey",
      region: "cn-beijing",
      action: "GetAFPUsage",
      now: new Date("2024-06-21T00:00:00.000Z"),
    });
    assert.equal(signed.xDate, "20240621T000000Z");
    assert.equal(signed.contentHash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.match(
      signed.authorization,
      /^HMAC-SHA256 Credential=AKLTtest\/20240621\/cn-beijing\/ark\/request, SignedHeaders=host;x-date;x-content-sha256;content-type, Signature=[0-9a-f]{64}$/,
    );
  });

  it("parses 5h, weekly, and monthly Agent Plan windows", () => {
    const windows = parseAgentPlanWindows({
      AFPFiveHour: { Quota: 50, Used: 12.5, ResetTime: 1778806800000 },
      AFPDaily: { Quota: 100, Used: 22.5, ResetTime: 1778803200000 },
      AFPWeekly: { Quota: 500, Used: 150, ResetTime: 1779062400000 },
      AFPMonthly: { Quota: 2000, Used: 850.5, ResetTime: 1780531200000 },
    });
    assert.equal(windows.primary_window.used_percent, 25);
    assert.equal(windows.primary_window.remaining_credits, 37.5);
    assert.equal(windows.secondary_window.used_percent, 30);
    assert.equal(windows.tertiary_window.used_percent, 42.525);
    assert.equal(Object.hasOwn(windows, "AFPDaily"), false);
  });

  it("parses legacy Coding Plan percentage windows", () => {
    const windows = parseCodingPlanWindows({
      QuotaUsage: [
        { Level: "session", Percent: 0, ResetTimestamp: -1 },
        { Level: "weekly", Percent: 1.672568, ResetTimestamp: 1782057600 },
        { Level: "monthly", Percent: 0.836284, ResetTimestamp: 1784303999 },
      ],
    });
    assert.equal(windows.primary_window.used_percent, 0);
    assert.equal(windows.primary_window.reset_at, null);
    assert.equal(windows.secondary_window.used_percent, 1.672568);
    assert.match(windows.tertiary_window.reset_at, /^2026-/);
  });

  it("queries the official control plane with credentials stored by TokenTracker", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-volcengine-limits-"));
    try {
      await saveProviderCredentials("volcengine", {
        access_key_id: "AKLTlocal",
        secret_access_key: "local-secret",
        region: "cn-beijing",
      }, { home });
      const result = await fetchVolcengineLimits({
        home,
        now: new Date("2024-06-21T00:00:00.000Z"),
        fetchImpl: async (url, options) => {
          assert.match(url, /^https:\/\/open\.volcengineapi\.com\/\?Action=GetAFPUsage/);
          assert.equal(options.method, "POST");
          assert.match(options.headers.Authorization, /^HMAC-SHA256 Credential=AKLTlocal\//);
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({
                Result: {
                  PlanType: "Large",
                  AFPFiveHour: { Quota: 40, Used: 10, ResetTime: 1778806800000 },
                  AFPWeekly: { Quota: 400, Used: 80, ResetTime: 1779062400000 },
                  AFPMonthly: { Quota: 1600, Used: 200, ResetTime: 1780531200000 },
                },
              });
            },
          };
        },
      });
      assert.equal(result.configured, true);
      assert.equal(result.plan_label, "Agent Plan Large");
      assert.equal(result.primary_window.used_percent, 25);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
