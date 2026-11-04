import type { UiBundleState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeIncompatibility, shouldOfferUiBundle } from "./uiBundle.logic";

const state: UiBundleState = {
  enabled: true,
  builtinVersion: "1.0.0",
  active: "builtin",
  previous: null,
  ready: null,
  incompatible: null,
  lastCheckedAt: null,
  lastError: null,
  bootPending: false,
};
const ready = { version: "1.0.1", size: 1 };

describe("shouldOfferUiBundle", () => {
  it("offers a ready bundle only on a server that has the capability", () => {
    expect(shouldOfferUiBundle({ uiBundles: true }, { ...state, ready })).toBe(true);
    expect(shouldOfferUiBundle({}, { ...state, ready })).toBe(false);
    expect(shouldOfferUiBundle(null, { ...state, ready })).toBe(false);
  });

  it("offers nothing without a ready bundle or a state", () => {
    expect(shouldOfferUiBundle({ uiBundles: true }, state)).toBe(false);
    expect(shouldOfferUiBundle({ uiBundles: true }, null)).toBe(false);
  });
});

describe("describeIncompatibility", () => {
  it("points at a server update for the reasons a server update fixes", () => {
    expect(describeIncompatibility("contracts-changed")).toMatch(/server/i);
    expect(describeIncompatibility("version-core-changed")).toMatch(/server/i);
  });

  it("explains a release that carries no compatibility data", () => {
    expect(describeIncompatibility("missing-compat")).toMatch(/not installed/i);
  });
});
