import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderCredentialsPanel } from "./ProviderCredentialsPanel.jsx";

const apiMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  saveProviderCredentials: vi.fn(),
  deleteProviderCredentials: vi.fn(),
}));

vi.mock("../../lib/api", () => apiMocks);

const providers = {
  deepseek: { configured: true, api_key_hint: "sk-••••1234" },
  volcengine: {
    configured: true,
    access_key_id_hint: "AKLT••••5678",
    secret_access_key_set: true,
    region: "cn-beijing",
  },
};

describe("ProviderCredentialsPanel", () => {
  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.getProviderCredentials.mockResolvedValue({ ok: true, providers });
  });

  it("shows masked state without prefilling plaintext secrets", async () => {
    render(<ProviderCredentialsPanel />);

    await screen.findByText(/sk-••••1234/);
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(screen.getByLabelText("AccessKey ID")).toHaveValue("");
    expect(screen.getByLabelText("Secret Access Key")).toHaveValue("");
    expect(screen.getByLabelText("Region")).toHaveValue("cn-beijing");
    expect(document.body.textContent).not.toContain("deepseek-secret");
  });

  it("saves DeepSeek locally and clears the typed key after success", async () => {
    const user = userEvent.setup();
    apiMocks.saveProviderCredentials.mockResolvedValue({ ok: true, providers });
    render(<ProviderCredentialsPanel />);
    await screen.findByText(/sk-••••1234/);

    const input = screen.getByLabelText("API Key");
    await user.type(input, "sk-new-secret");
    const deepseekSection = screen.getByText("DeepSeek").closest("section");
    await act(async () => {
      await user.click(deepseekSection.querySelector("button:last-of-type"));
    });

    await waitFor(() => {
      expect(apiMocks.saveProviderCredentials).toHaveBeenCalledWith("deepseek", {
        api_key: "sk-new-secret",
      });
    });
    expect(input).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent("Credentials saved locally.");
  });

  it("keeps saved Volcengine secrets when blank fields are submitted with a new region", async () => {
    const user = userEvent.setup();
    apiMocks.saveProviderCredentials.mockResolvedValue({
      ok: true,
      providers: { ...providers, volcengine: { ...providers.volcengine, region: "cn-shanghai" } },
    });
    render(<ProviderCredentialsPanel />);
    await screen.findByText(/AKLT••••5678/);

    const region = screen.getByLabelText("Region");
    await user.clear(region);
    await user.type(region, "cn-shanghai");
    const volcengineSection = screen.getByText("Volcengine Ark").closest("section");
    await act(async () => {
      await user.click(volcengineSection.querySelector("button:last-of-type"));
    });

    await waitFor(() => {
      expect(apiMocks.saveProviderCredentials).toHaveBeenCalledWith("volcengine", {
        access_key_id: "",
        secret_access_key: "",
        region: "cn-shanghai",
      });
    });
  });

  it("removes a configured provider through the local API", async () => {
    const user = userEvent.setup();
    apiMocks.deleteProviderCredentials.mockResolvedValue({
      ok: true,
      providers: { ...providers, deepseek: { configured: false, api_key_hint: null } },
    });
    render(<ProviderCredentialsPanel />);
    await screen.findByText(/sk-••••1234/);

    const deepseekSection = screen.getByText("DeepSeek").closest("section");
    await act(async () => {
      await user.click(deepseekSection.querySelector("button"));
    });

    await waitFor(() => {
      expect(apiMocks.deleteProviderCredentials).toHaveBeenCalledWith("deepseek");
    });
    expect(screen.getByRole("status")).toHaveTextContent("Credentials removed.");
  });
});
