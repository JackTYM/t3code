import type {
  ExecutionEnvironmentCapabilities,
  UiBundleIncompatibleReason,
  UiBundleState,
} from "@t3tools/contracts";

/** An older server has no `uiBundles` capability and would reject the call, so it never offers one. */
export function shouldOfferUiBundle(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "uiBundles"> | null | undefined,
  state: UiBundleState | null,
): boolean {
  return capabilities?.uiBundles === true && state !== null && state.ready !== null;
}

export function describeIncompatibility(reason: UiBundleIncompatibleReason): string {
  switch (reason) {
    case "contracts-changed":
      return "This UI release changed how it talks to the server. Update the server to get it.";
    case "version-core-changed":
      return "This UI release is for a different server version. Update the server to get it.";
    case "missing-compat":
      return "This UI release does not say which servers it works with, so it was not installed.";
  }
}
