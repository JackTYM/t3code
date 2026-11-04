export interface UiCompat {
  readonly schema: 1;
  readonly contractsHash: string;
  readonly versionCore: string;
  readonly version: string;
  readonly sha: string;
  /** owner/repo whose releases publish UI bundles; empty disables UI updates. */
  readonly repository: string;
}

export type UiBundleCompatibility =
  | { readonly compatible: true }
  | {
      readonly compatible: false;
      readonly reason: "contracts-changed" | "version-core-changed" | "missing-compat";
    };

/**
 * A UI bundle may replace the client a server shipped with only when it was built against the
 * same wire contracts. `orchestrationProtocol` is a single integer and does not move for every
 * schema change, so it cannot decide this.
 */
export function decideUiBundleCompat(
  server: UiCompat | null,
  bundle: UiCompat | null,
): UiBundleCompatibility {
  if (server === null || bundle === null) return { compatible: false, reason: "missing-compat" };
  if (server.contractsHash !== bundle.contractsHash) {
    return { compatible: false, reason: "contracts-changed" };
  }
  // versionSkew.ts warns when the client and server version cores differ.
  if (server.versionCore !== bundle.versionCore) {
    return { compatible: false, reason: "version-core-changed" };
  }
  return { compatible: true };
}
