import { describe, expect, it } from "vite-plus/test";

import { mcpServerActions, mcpServersUnavailableCopy } from "./McpServersPanel.logic";

describe("mcpServerActions", () => {
  it("offers reconnect on servers that can be retried and disable while enabled", () => {
    for (const state of ["connected", "failed", "needs-auth"] as const) {
      expect(mcpServerActions({ state })).toEqual({ reconnect: true, toggle: "disable" });
    }
  });

  it("only offers enable on a disabled server", () => {
    expect(mcpServerActions({ state: "disabled" })).toEqual({ reconnect: false, toggle: "enable" });
  });

  it("leaves a connecting server alone", () => {
    expect(mcpServerActions({ state: "pending" })).toEqual({ reconnect: false, toggle: null });
  });
});

describe("mcpServersUnavailableCopy", () => {
  it("tells a stopped session apart from a provider that cannot report servers", () => {
    expect(mcpServersUnavailableCopy("session-stopped").description).toMatch(/Send a message/);
    expect(mcpServersUnavailableCopy("provider-unsupported").description).toMatch(
      /cannot show or repair/,
    );
  });

  it("points an outdated environment at an update", () => {
    expect(mcpServersUnavailableCopy("server-outdated").description).toMatch(/Update T3 Code/);
  });
});
