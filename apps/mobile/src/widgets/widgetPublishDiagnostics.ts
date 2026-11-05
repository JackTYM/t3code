import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

/** "unavailable" means this build has no ExpoWidgets module, so nothing could be written. */
export type WidgetPublishOutcome = "published" | "unavailable";

export function describeWidgetPublish(
  outcome: WidgetPublishOutcome,
  snapshot: Pick<SubscriptionUsageSnapshot, "providers">,
): string {
  if (outcome === "unavailable") return "This build has no widget support, so nothing was sent.";
  const limits = snapshot.providers.reduce((total, provider) => total + provider.windows.length, 0);
  return limits === 0
    ? "Sent the widget its layout, but no provider usage is available yet. Connect an environment that reports Codex or Claude limits."
    : `Sent ${limits} usage limit${limits === 1 ? "" : "s"} to the widget.`;
}

export function describeWidgetPublishFailure(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
