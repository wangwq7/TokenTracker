const { readProviderCredentials } = require("./provider-credentials");

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const DEFAULT_TIMEOUT_MS = 15_000;

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeDeepSeekBalance(body) {
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const balances = infos
    .map((info) => {
      const amount = finiteNumber(info?.total_balance);
      if (amount === null) return null;
      return {
        currency: typeof info?.currency === "string" && info.currency.trim()
          ? info.currency.trim().toUpperCase()
          : "CNY",
        amount,
        granted_balance: finiteNumber(info?.granted_balance),
        topped_up_balance: finiteNumber(info?.topped_up_balance),
      };
    })
    .filter(Boolean);

  return {
    configured: true,
    error: null,
    available: body?.is_available !== false,
    balances,
  };
}

async function fetchDeepSeekBalance({
  home,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const apiKey = readProviderCredentials({ home }).deepseek.api_key;
  if (!apiKey) return { configured: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return { configured: true, error: "DeepSeek authentication failed. Update the API key in Limits settings." };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        configured: true,
        error: `DeepSeek balance API error ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
      };
    }

    const body = await response.json();
    const normalized = normalizeDeepSeekBalance(body);
    if (normalized.balances.length === 0) {
      return { configured: true, error: "DeepSeek balance response did not contain any balances." };
    }
    return normalized;
  } catch (error) {
    if (error?.name === "AbortError") {
      return { configured: true, error: "DeepSeek balance request timed out." };
    }
    return { configured: true, error: error?.message || "DeepSeek balance request failed." };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEEPSEEK_BALANCE_URL,
  fetchDeepSeekBalance,
  finiteNumber,
  normalizeDeepSeekBalance,
};
