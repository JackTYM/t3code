import { describe, expect, it } from "vite-plus/test";

import { describeWidgetPublish, describeWidgetPublishFailure } from "./widgetPublishDiagnostics";

const provider = (windows: number) => ({
  name: "Codex",
  detail: "",
  expiresAt: 0,
  totalWindows: windows,
  windows: Array.from({ length: windows }, () => ({
    kind: "session" as const,
    label: "Session",
    remaining: 50,
    reset: "",
  })),
});

describe("describeWidgetPublish", () => {
  it("says so when the build has no widget module", () => {
    expect(describeWidgetPublish("unavailable", { providers: [] })).toMatch(/no widget support/);
  });

  it("counts usage limits across providers", () => {
    expect(describeWidgetPublish("published", { providers: [provider(2), provider(1)] })).toBe(
      "Sent 3 usage limits to the widget.",
    );
    expect(describeWidgetPublish("published", { providers: [provider(1)] })).toBe(
      "Sent 1 usage limit to the widget.",
    );
  });

  it("tells a published layout with no usage data apart from success", () => {
    expect(describeWidgetPublish("published", { providers: [provider(0)] })).toMatch(
      /no provider usage/,
    );
  });
});

describe("describeWidgetPublishFailure", () => {
  it("keeps the error name, which names the native failure", () => {
    const error = new Error("layout missing");
    error.name = "UpdatedTimelineWithoutLayout";
    expect(describeWidgetPublishFailure(error)).toBe(
      "UpdatedTimelineWithoutLayout: layout missing",
    );
  });

  it("stringifies non-errors", () => {
    expect(describeWidgetPublishFailure("boom")).toBe("boom");
  });
});
