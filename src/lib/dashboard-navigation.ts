import {
  DASHBOARD_VIEW_REGISTRY,
  dashboardViewMetadata,
  type DashboardView,
} from "@/lib/dashboard-view-registry";

export type { DashboardView } from "@/lib/dashboard-view-registry";

const viewsByHash = new Map<string, DashboardView>(
  DASHBOARD_VIEW_REGISTRY.map((definition) => [definition.hash, definition.value] as const),
);

export function dashboardViewFromHash(hash: string): DashboardView {
  return viewsByHash.get(hash) ?? "overview";
}

export function dashboardHash(view: DashboardView): string {
  return dashboardViewMetadata(view).hash;
}
