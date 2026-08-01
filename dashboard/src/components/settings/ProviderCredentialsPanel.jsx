import React from "react";
import { KeyRound, Trash2 } from "lucide-react";
import {
  deleteProviderCredentials,
  getProviderCredentials,
  saveProviderCredentials,
} from "../../lib/api";
import { cn } from "../../lib/cn";
import { copy } from "../../lib/copy";
import { ProviderIcon } from "../../ui/dashboard/components/ProviderIcon.jsx";

const INPUT_CLASS =
  "w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 text-sm text-oai-gray-900 outline-none transition-colors placeholder:text-oai-gray-400 focus:border-oai-brand-500 focus:ring-2 focus:ring-inset focus:ring-oai-brand-500/20 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-gray-100 dark:placeholder:text-oai-gray-600";

function CredentialField({ label, value, onChange, placeholder, type = "text", autoComplete = "off" }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-xs font-medium text-oai-gray-600 dark:text-oai-gray-300">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        className={INPUT_CLASS}
      />
    </label>
  );
}

function ProviderStatus({ configured, hint }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        configured
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-300"
          : "border-oai-gray-200 bg-oai-gray-50 text-oai-gray-500 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-gray-400",
      )}
      title={hint || undefined}
    >
      <span className="truncate">
        {configured
          ? copy("settings.provider_credentials.configured", { hint: hint || copy("shared.placeholder.short") })
          : copy("settings.provider_credentials.not_configured")}
      </span>
    </span>
  );
}

function ActionButtons({ provider, configured, busyProvider, onSave, onRemove }) {
  const busy = busyProvider === provider;
  return (
    <div className="flex items-center justify-end gap-2">
      {configured ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={Boolean(busyProvider)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-oai-gray-200 px-3 py-1.5 text-xs font-medium text-oai-gray-600 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-oai-gray-700 dark:text-oai-gray-300 dark:hover:border-red-900/60 dark:hover:bg-red-950/30 dark:hover:text-red-300"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          {copy("settings.provider_credentials.remove")}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onSave}
        disabled={Boolean(busyProvider)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-oai-black px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-oai-black"
      >
        <KeyRound className="h-3.5 w-3.5" aria-hidden />
        {busy
          ? copy("settings.provider_credentials.saving")
          : copy("settings.provider_credentials.save")}
      </button>
    </div>
  );
}

function ProviderHeader({ id, icon, title, description, configured, hint }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <ProviderIcon provider={icon} size={20} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <div id={id} className="text-sm font-medium text-oai-gray-900 dark:text-oai-gray-100">{title}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-oai-gray-500 dark:text-oai-gray-400">
            {description}
          </p>
        </div>
      </div>
      <div className="min-w-0 shrink-0 max-w-[45%]">
        <ProviderStatus configured={configured} hint={hint} />
      </div>
    </div>
  );
}

export function ProviderCredentialsPanel() {
  const [providers, setProviders] = React.useState(null);
  const [deepseekApiKey, setDeepseekApiKey] = React.useState("");
  const [volcengineAccessKey, setVolcengineAccessKey] = React.useState("");
  const [volcengineSecretKey, setVolcengineSecretKey] = React.useState("");
  const [volcengineRegion, setVolcengineRegion] = React.useState("cn-beijing");
  const [busyProvider, setBusyProvider] = React.useState(null);
  const [notice, setNotice] = React.useState(null);

  React.useEffect(() => {
    let active = true;
    getProviderCredentials()
      .then((payload) => {
        if (!active) return;
        const next = payload?.providers || {};
        setProviders(next);
        setVolcengineRegion(next.volcengine?.region || "cn-beijing");
      })
      .catch((error) => {
        if (!active) return;
        setProviders({});
        setNotice({ tone: "error", text: copy("shared.error.prefix", { error: error?.message || copy("settings.provider_credentials.load_failed") }) });
      });
    return () => {
      active = false;
    };
  }, []);

  const runMutation = async (provider, mutation, successText) => {
    setBusyProvider(provider);
    setNotice(null);
    try {
      const payload = await mutation();
      const next = payload?.providers || {};
      setProviders(next);
      setVolcengineRegion(next.volcengine?.region || "cn-beijing");
      setNotice({ tone: "success", text: successText });
      if (provider === "deepseek") setDeepseekApiKey("");
      if (provider === "volcengine") {
        setVolcengineAccessKey("");
        setVolcengineSecretKey("");
      }
    } catch (error) {
      setNotice({
        tone: "error",
        text: copy("shared.error.prefix", {
          error: error?.message || copy("settings.provider_credentials.save_failed"),
        }),
      });
    } finally {
      setBusyProvider(null);
    }
  };

  const saveDeepSeek = () => {
    const apiKey = deepseekApiKey.trim();
    if (!apiKey) {
      setNotice({ tone: "error", text: copy("settings.provider_credentials.deepseek_required") });
      return;
    }
    void runMutation(
      "deepseek",
      () => saveProviderCredentials("deepseek", { api_key: apiKey }),
      copy("settings.provider_credentials.saved"),
    );
  };

  const saveVolcengine = () => {
    const configured = providers?.volcengine?.configured === true;
    const accessKeyId = volcengineAccessKey.trim();
    const secretAccessKey = volcengineSecretKey.trim();
    const region = volcengineRegion.trim() || "cn-beijing";
    if (!configured && (!accessKeyId || !secretAccessKey)) {
      setNotice({ tone: "error", text: copy("settings.provider_credentials.volcengine_required") });
      return;
    }
    void runMutation(
      "volcengine",
      () => saveProviderCredentials("volcengine", {
        access_key_id: accessKeyId,
        secret_access_key: secretAccessKey,
        region,
      }),
      copy("settings.provider_credentials.saved"),
    );
  };

  const removeProvider = (provider) => {
    void runMutation(
      provider,
      () => deleteProviderCredentials(provider),
      copy("settings.provider_credentials.removed"),
    );
  };

  const deepseek = providers?.deepseek || {};
  const volcengine = providers?.volcengine || {};

  return (
    <div className="flex flex-col" data-provider-credentials-panel="">
      {providers === null ? (
        <div className="py-4 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {copy("settings.provider_credentials.loading")}
        </div>
      ) : (
        <>
          <section className="space-y-3 py-3" aria-labelledby="provider-credentials-deepseek">
            <ProviderHeader
              id="provider-credentials-deepseek"
              icon="DEEPSEEK"
              title={copy("limits.provider.deepseek")}
              description={copy("settings.provider_credentials.deepseek_description")}
              configured={deepseek.configured === true}
              hint={deepseek.api_key_hint}
            />
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <CredentialField
                label={copy("settings.provider_credentials.api_key")}
                value={deepseekApiKey}
                onChange={setDeepseekApiKey}
                placeholder={deepseek.api_key_hint || copy("settings.provider_credentials.deepseek_placeholder")}
                type="password"
                autoComplete="new-password"
              />
              <ActionButtons
                provider="deepseek"
                configured={deepseek.configured === true}
                busyProvider={busyProvider}
                onSave={saveDeepSeek}
                onRemove={() => removeProvider("deepseek")}
              />
            </div>
          </section>

          <section className="space-y-3 border-t border-oai-gray-200/60 py-3 dark:border-oai-gray-800/60" aria-labelledby="provider-credentials-volcengine">
            <ProviderHeader
              id="provider-credentials-volcengine"
              icon="VOLCENGINE"
              title={copy("limits.provider.volcengine")}
              description={copy("settings.provider_credentials.volcengine_description")}
              configured={volcengine.configured === true}
              hint={volcengine.access_key_id_hint}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <CredentialField
                label={copy("settings.provider_credentials.access_key_id")}
                value={volcengineAccessKey}
                onChange={setVolcengineAccessKey}
                placeholder={volcengine.access_key_id_hint || copy("settings.provider_credentials.access_key_placeholder")}
                type="password"
                autoComplete="new-password"
              />
              <CredentialField
                label={copy("settings.provider_credentials.secret_access_key")}
                value={volcengineSecretKey}
                onChange={setVolcengineSecretKey}
                placeholder={volcengine.secret_access_key_set
                  ? copy("settings.provider_credentials.secret_saved_placeholder")
                  : copy("settings.provider_credentials.secret_key_placeholder")}
                type="password"
                autoComplete="new-password"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <CredentialField
                label={copy("settings.provider_credentials.region")}
                value={volcengineRegion}
                onChange={setVolcengineRegion}
                placeholder={copy("settings.provider_credentials.region_placeholder")}
              />
              <ActionButtons
                provider="volcengine"
                configured={volcengine.configured === true}
                busyProvider={busyProvider}
                onSave={saveVolcengine}
                onRemove={() => removeProvider("volcengine")}
              />
            </div>
          </section>
        </>
      )}

      {notice ? (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "border-t border-oai-gray-200/60 py-2 text-xs dark:border-oai-gray-800/60",
            notice.tone === "error"
              ? "text-red-600 dark:text-red-400"
              : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {notice.text}
        </div>
      ) : null}
    </div>
  );
}
