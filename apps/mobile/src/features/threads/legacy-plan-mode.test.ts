import { describe, expect, it } from "@effect/vitest";

import {
  resolveLegacyPlanModeEnabled,
  resolvePendingTaskInteractionMode,
  resolveProviderInteractionMode,
} from "./legacy-plan-mode";

describe("resolveProviderInteractionMode", () => {
  it("clears saved plan mode when the provider cannot use T3 interaction modes", () => {
    expect(resolveProviderInteractionMode({ showInteractionModeToggle: false }, "plan")).toBe(
      "default",
    );
  });

  it("keeps supported choices and remains compatible with older server status", () => {
    expect(resolveProviderInteractionMode({ showInteractionModeToggle: true }, "plan")).toBe(
      "plan",
    );
    expect(resolveProviderInteractionMode({}, "plan")).toBe("plan");
    expect(resolveProviderInteractionMode(null, "plan")).toBe("plan");
    expect(resolveProviderInteractionMode(undefined, undefined)).toBe("default");
  });
});

describe("resolveLegacyPlanModeEnabled", () => {
  it("enables plan mode on a device that never set the preference", () => {
    expect(resolveLegacyPlanModeEnabled({ preference: undefined })).toBe(true);
  });

  it("honors an explicit opt-out", () => {
    expect(resolveLegacyPlanModeEnabled({ preference: false })).toBe(false);
    expect(resolveLegacyPlanModeEnabled({ preference: true })).toBe(true);
  });

  // An unread device store yields `undefined`, the same as a device that never
  // set the preference. Reading that as disabled is the mobile counterpart of
  // the web pre-hydration clamp: it downgraded a persisted plan thread to build
  // for the duration of the load.
  it("does not clamp to build while the device store is still unread", () => {
    expect(resolveLegacyPlanModeEnabled({ preference: undefined })).toBe(true);
  });
});

describe("resolvePendingTaskInteractionMode", () => {
  it("clears a queued plan mode the provider cannot use", () => {
    expect(
      resolvePendingTaskInteractionMode({
        planModeEnabled: true,
        draftInteractionMode: "plan",
        provider: { showInteractionModeToggle: false },
      }),
    ).toBe("default");
  });

  it("forces build mode when the device opted out of plan mode", () => {
    expect(
      resolvePendingTaskInteractionMode({
        planModeEnabled: false,
        draftInteractionMode: "plan",
      }),
    ).toBe("default");
  });

  it("honors the draft's mode when plan mode is enabled", () => {
    expect(
      resolvePendingTaskInteractionMode({
        planModeEnabled: true,
        draftInteractionMode: "plan",
      }),
    ).toBe("plan");
    expect(
      resolvePendingTaskInteractionMode({
        planModeEnabled: true,
        draftInteractionMode: undefined,
      }),
    ).toBe("default");
  });

  // A task opened for editing has its mode copied onto the draft by
  // `beginEditingPendingTask`, so a queued plan task survives on the draft
  // alone — including while the device preference is still unread, which now
  // resolves as enabled instead of clamping the task to build.
  it("sends an edited queued plan task in plan mode", () => {
    expect(
      resolvePendingTaskInteractionMode({
        planModeEnabled: resolveLegacyPlanModeEnabled({ preference: undefined }),
        draftInteractionMode: "plan",
      }),
    ).toBe("plan");
  });
});
