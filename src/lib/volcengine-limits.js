const crypto = require("node:crypto");

const { readProviderCredentials } = require("./provider-credentials");

const VOLCENGINE_OPENAPI_HOST = "open.volcengineapi.com";
const VOLCENGINE_API_VERSION = "2024-01-01";
const VOLCENGINE_DEFAULT_REGION = "cn-beijing";
const VOLCENGINE_SERVICE = "ark";
const VOLCENGINE_CONTENT_TYPE = "application/json; charset=utf-8";
const VOLCENGINE_SIGNED_HEADERS = "host;x-date;x-content-sha256;content-type";
const DEFAULT_TIMEOUT_MS = 15_000;

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

function parseFinite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoFromEpoch(value) {
  const n = parseFinite(value);
  if (n === null || n <= 0) return null;
  const ms = n > 10_000_000_000 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function uriEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(action, region = VOLCENGINE_DEFAULT_REGION) {
  return [
    ["Action", action],
    ["Region", region],
    ["Version", VOLCENGINE_API_VERSION],
  ]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join("&");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function formatVolcengineDate(now) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signVolcengineRequest({
  accessKeyId,
  secretAccessKey,
  region = VOLCENGINE_DEFAULT_REGION,
  action = "GetAFPUsage",
  body = "",
  now = new Date(),
}) {
  const query = canonicalQuery(action, region);
  const xDate = formatVolcengineDate(now);
  const shortDate = xDate.slice(0, 8);
  const contentHash = sha256Hex(body);
  const canonicalHeaders = [
    `host:${VOLCENGINE_OPENAPI_HOST}`,
    `x-date:${xDate}`,
    `x-content-sha256:${contentHash}`,
    `content-type:${VOLCENGINE_CONTENT_TYPE}`,
    "",
  ].join("\n");
  const canonicalRequest = [
    "POST",
    "/",
    query,
    canonicalHeaders,
    VOLCENGINE_SIGNED_HEADERS,
    contentHash,
  ].join("\n");
  const scope = `${shortDate}/${region}/${VOLCENGINE_SERVICE}/request`;
  const stringToSign = [
    "HMAC-SHA256",
    xDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(Buffer.from(secretAccessKey, "utf8"), shortDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, VOLCENGINE_SERVICE);
  const kSigning = hmac(kService, "request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return {
    query,
    xDate,
    contentHash,
    authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${VOLCENGINE_SIGNED_HEADERS}, Signature=${signature}`,
  };
}

function responseError(body) {
  const error = body?.ResponseMetadata?.Error || body?.Error;
  if (!error || typeof error !== "object") return null;
  const code = typeof error.Code === "string" ? error.Code : "";
  const message = typeof error.Message === "string" ? error.Message : "";
  return code || message ? { code, message } : null;
}

function isAuthErrorCode(code) {
  return /auth|signature|accessdenied|denied|unauthorized|forbidden|credential|token/i.test(String(code || ""));
}

function parseAgentPlanWindows(result) {
  const definitions = [
    ["AFPFiveHour", "primary_window"],
    ["AFPWeekly", "secondary_window"],
    ["AFPMonthly", "tertiary_window"],
  ];
  const windows = {};
  for (const [sourceKey, targetKey] of definitions) {
    const value = result?.[sourceKey];
    if (!value || typeof value !== "object") continue;
    const quota = parseFinite(value.Quota);
    if (!(quota > 0)) continue;
    const used = parseFinite(value.Used) || 0;
    windows[targetKey] = {
      used_percent: clampPercent((used / quota) * 100),
      reset_at: isoFromEpoch(value.ResetTime),
      limit_credits: quota,
      used_credits: used,
      remaining_credits: Math.max(0, quota - used),
      unit: "AFP",
    };
  }
  return windows;
}

function codingWindowKey(label) {
  switch (String(label || "").toLowerCase()) {
    case "session":
    case "5h":
    case "fivehour":
    case "five_hour":
    case "rolling_5h":
      return "primary_window";
    case "weekly":
    case "week":
    case "7d":
      return "secondary_window";
    case "monthly":
    case "month":
      return "tertiary_window";
    default:
      return null;
  }
}

function parseCodingPlanWindows(result) {
  const rows = Array.isArray(result?.QuotaUsage)
    ? result.QuotaUsage
    : Array.isArray(result?.Usages)
      ? result.Usages
      : Array.isArray(result?.Details)
        ? result.Details
        : [];
  const windows = {};
  for (const item of rows) {
    const key = codingWindowKey(item?.Level ?? item?.Type ?? item?.Period ?? item?.Label ?? item?.Window);
    if (!key) continue;
    const used = parseFinite(item?.Percent ?? item?.UsedPercent ?? item?.UsagePercent);
    if (used === null) continue;
    windows[key] = {
      used_percent: clampPercent(used),
      reset_at: isoFromEpoch(item?.ResetTime ?? item?.ResetTimestamp),
    };
  }
  return windows;
}

async function openApiCall({
  accessKeyId,
  secretAccessKey,
  region,
  action,
  fetchImpl,
  timeoutMs,
  now,
}) {
  const body = "";
  const signed = signVolcengineRequest({
    accessKeyId,
    secretAccessKey,
    region,
    action,
    body,
    now,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `https://${VOLCENGINE_OPENAPI_HOST}/?${signed.query}`,
      {
        method: "POST",
        headers: {
          Authorization: signed.authorization,
          "Content-Type": VOLCENGINE_CONTENT_TYPE,
          "X-Content-Sha256": signed.contentHash,
          "X-Date": signed.xDate,
        },
        body,
        signal: controller.signal,
      },
    );
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (_error) {
      return { kind: "error", error: `Volcengine returned invalid JSON (HTTP ${response.status}).` };
    }
    const envelopeError = responseError(parsed);
    if (response.status === 401 || response.status === 403 || isAuthErrorCode(envelopeError?.code)) {
      return {
        kind: "auth",
        error: "Volcengine authentication failed. Update the account AccessKey ID and Secret in Limits settings.",
      };
    }
    if (!response.ok || envelopeError) {
      const detail = envelopeError
        ? [envelopeError.code, envelopeError.message].filter(Boolean).join(": ")
        : `HTTP ${response.status}`;
      return { kind: "error", error: `Volcengine ${action} failed: ${detail}` };
    }
    return { kind: "body", body: parsed };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { kind: "error", error: `Volcengine ${action} request timed out.` };
    }
    return { kind: "error", error: error?.message || `Volcengine ${action} request failed.` };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchVolcengineLimits({
  home,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = new Date(),
} = {}) {
  const credentials = readProviderCredentials({ home }).volcengine;
  if (!credentials.access_key_id || !credentials.secret_access_key) {
    return { configured: false };
  }
  const common = {
    accessKeyId: credentials.access_key_id,
    secretAccessKey: credentials.secret_access_key,
    region: credentials.region || VOLCENGINE_DEFAULT_REGION,
    fetchImpl,
    timeoutMs,
    now,
  };

  const agent = await openApiCall({ ...common, action: "GetAFPUsage" });
  if (agent.kind === "auth") return { configured: true, error: agent.error };
  if (agent.kind === "body") {
    const result = agent.body?.Result || agent.body;
    const windows = parseAgentPlanWindows(result);
    if (Object.keys(windows).length > 0) {
      const tier = typeof result?.PlanType === "string" ? result.PlanType.trim() : "";
      return {
        configured: true,
        error: null,
        plan_label: tier ? `Agent Plan ${tier}` : "Agent Plan",
        ...windows,
      };
    }
  }

  const coding = await openApiCall({ ...common, action: "GetCodingPlanUsage" });
  if (coding.kind === "auth") return { configured: true, error: coding.error };
  if (coding.kind === "body") {
    const windows = parseCodingPlanWindows(coding.body?.Result || coding.body);
    if (Object.keys(windows).length > 0) {
      return {
        configured: true,
        error: null,
        plan_label: "Coding Plan",
        ...windows,
      };
    }
  }

  return {
    configured: true,
    error: agent.error || coding.error || "No active Volcengine Agent Plan or Coding Plan quota was found.",
  };
}

module.exports = {
  VOLCENGINE_CONTENT_TYPE,
  VOLCENGINE_DEFAULT_REGION,
  VOLCENGINE_OPENAPI_HOST,
  canonicalQuery,
  fetchVolcengineLimits,
  formatVolcengineDate,
  isAuthErrorCode,
  isoFromEpoch,
  parseAgentPlanWindows,
  parseCodingPlanWindows,
  responseError,
  signVolcengineRequest,
};
