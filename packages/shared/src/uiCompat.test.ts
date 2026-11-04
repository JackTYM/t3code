import { describe, expect, it } from "vite-plus/test";
import { decideUiBundleCompat, type UiCompat } from "./uiCompat.ts";

const base: UiCompat = {
  schema: 1,
  contractsHash: "aaa",
  versionCore: "0.1.6",
  version: "0.1.6-fork.4",
  sha: "abc",
  repository: "JackTYM/t3code",
};

describe("decideUiBundleCompat", () => {
  it("accepts a bundle with the same contracts and version core", () => {
    expect(decideUiBundleCompat(base, { ...base, version: "0.1.6-fork.9" })).toEqual({
      compatible: true,
    });
  });
  it("rejects changed contracts", () => {
    expect(decideUiBundleCompat(base, { ...base, contractsHash: "bbb" })).toEqual({
      compatible: false,
      reason: "contracts-changed",
    });
  });
  it("rejects a different version core", () => {
    expect(decideUiBundleCompat(base, { ...base, versionCore: "0.2.0" })).toEqual({
      compatible: false,
      reason: "version-core-changed",
    });
  });
  it("rejects when either side has no compat file", () => {
    expect(decideUiBundleCompat(null, base)).toEqual({
      compatible: false,
      reason: "missing-compat",
    });
    expect(decideUiBundleCompat(base, null)).toEqual({
      compatible: false,
      reason: "missing-compat",
    });
  });
});
