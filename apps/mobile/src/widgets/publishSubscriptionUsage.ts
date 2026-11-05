import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";
import type { WidgetPublishOutcome } from "./widgetPublishDiagnostics";

export function publishSubscriptionUsage(
  _snapshot: SubscriptionUsageSnapshot,
): Promise<WidgetPublishOutcome> {
  return Promise.resolve("unavailable");
}
