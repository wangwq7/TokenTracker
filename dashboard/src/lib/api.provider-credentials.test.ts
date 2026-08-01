import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteProviderCredentials,
  getProviderCredentials,
  saveProviderCredentials,
} from "./api";

vi.mock("./local-api-auth", () => ({
  getLocalApiAuthHeaders: vi.fn(async () => ({ "x-tokentracker-local-auth": "local-token" })),
}));

describe("provider credentials API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses local auth and never expects plaintext secrets from the read response", async () => {
    const payload = {
      ok: true,
      providers: {
        deepseek: { configured: true, api_key_hint: "sk-••••1234" },
        volcengine: {
          configured: true,
          access_key_id_hint: "AKLT••••5678",
          secret_access_key_set: true,
          region: "cn-beijing",
        },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getProviderCredentials()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/functions/tokentracker-provider-credentials",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
          "x-tokentracker-local-auth": "local-token",
        }),
        cache: "no-store",
      }),
    );
  });

  it("sends save and remove mutations through the authenticated local endpoint", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ ok: true, providers: {} }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await saveProviderCredentials("deepseek", { api_key: "secret" });
    await deleteProviderCredentials("deepseek");

    expect(fetchMock.mock.calls[0]).toEqual([
      "/functions/tokentracker-provider-credentials",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ provider: "deepseek", credentials: { api_key: "secret" } }),
      }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      "/functions/tokentracker-provider-credentials",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ provider: "deepseek" }),
      }),
    ]);
  });
});
