import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const UiBundleIncompatibleReason = Schema.Literals([
  "contracts-changed",
  "version-core-changed",
  "missing-compat",
]);
export type UiBundleIncompatibleReason = typeof UiBundleIncompatibleReason.Type;

/** Published next to the zip on the release; also what the server compares against. */
export const UiBundleManifest = Schema.Struct({
  schema: Schema.Literal(1),
  version: TrimmedNonEmptyString,
  versionCore: TrimmedNonEmptyString,
  contractsHash: TrimmedNonEmptyString,
  sha: Schema.String,
  sha256: TrimmedNonEmptyString,
  size: Schema.Number,
  assetName: TrimmedNonEmptyString,
});
export type UiBundleManifest = typeof UiBundleManifest.Type;

export const UiBundleState = Schema.Struct({
  /** Whether this server can offer UI bundles at all (a baked repository exists). */
  enabled: Schema.Boolean,
  builtinVersion: Schema.String,
  active: Schema.Union([Schema.Literal("builtin"), TrimmedNonEmptyString]),
  previous: Schema.NullOr(TrimmedNonEmptyString),
  ready: Schema.NullOr(Schema.Struct({ version: TrimmedNonEmptyString, size: Schema.Number })),
  incompatible: Schema.NullOr(
    Schema.Struct({ version: TrimmedNonEmptyString, reason: UiBundleIncompatibleReason }),
  ),
  lastCheckedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  /** An applied bundle is waiting for the UI to confirm it mounted. */
  bootPending: Schema.Boolean,
});
export type UiBundleState = typeof UiBundleState.Type;

export const UiBundleConfirmBootInput = Schema.Struct({ version: TrimmedNonEmptyString });
export type UiBundleConfirmBootInput = typeof UiBundleConfirmBootInput.Type;

export class UiBundleError extends Schema.TaggedError<UiBundleError>()("UiBundleError", {
  reason: Schema.Literals(["disabled", "nothing-ready", "check-failed", "apply-failed"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "disabled":
        return "This server does not offer UI updates.";
      case "nothing-ready":
        return "No UI update is ready to apply.";
      case "check-failed":
        return "Could not check for a UI update.";
      case "apply-failed":
        return "Could not switch to the new UI.";
    }
  }
}
