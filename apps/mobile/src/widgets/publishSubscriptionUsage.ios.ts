import { requireOptionalNativeModule } from "expo";
import {
  subscriptionUsageTimeline,
  type SubscriptionUsageSnapshot,
} from "./subscriptionUsageSnapshot";
import type { WidgetPublishOutcome } from "./widgetPublishDiagnostics";

export async function publishSubscriptionUsage(
  snapshot: SubscriptionUsageSnapshot,
): Promise<WidgetPublishOutcome> {
  if (!requireOptionalNativeModule("ExpoWidgets")) return "unavailable";
  const { default: widget } = await import("./SubscriptionUsage");
  widget.updateTimeline(subscriptionUsageTimeline(snapshot, Date.now()));
  return "published";
}
