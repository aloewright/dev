/* AGPL-3.0-or-later */
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { App } from "@/App";
import { RootLayout } from "@/AppShell";
import { CommandCenter } from "@/CommandCenter";
import { RunsPage } from "@/components/RunsPage";
import { SettingsPage } from "@/components/SettingsPage";
import { CorePage } from "@/components/CorePage";
import { WorkflowsPage } from "@/components/WorkflowsPage";

const rootRoute = createRootRoute({ component: RootLayout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: App });
const runsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/runs", component: RunsPage });
const commandCenterRoute = createRoute({ getParentRoute: () => rootRoute, path: "/command-center", component: CommandCenter });
const coreRoute = createRoute({ getParentRoute: () => rootRoute, path: "/core", component: CorePage });
const workflowsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/workflows", component: WorkflowsPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });

const routeTree = rootRoute.addChildren([indexRoute, runsRoute, commandCenterRoute, coreRoute, workflowsRoute, settingsRoute]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
