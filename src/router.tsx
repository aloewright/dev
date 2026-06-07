/* AGPL-3.0-or-later */
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { App } from "@/App";
import { RootLayout } from "@/AppShell";
import { CommandCenter } from "@/CommandCenter";
import { RunsPage } from "@/components/RunsPage";
import { SettingsPage } from "@/components/SettingsPage";

const rootRoute = createRootRoute({ component: RootLayout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: App });
const runsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/runs", component: RunsPage });
const commandCenterRoute = createRoute({ getParentRoute: () => rootRoute, path: "/command-center", component: CommandCenter });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });

const routeTree = rootRoute.addChildren([indexRoute, runsRoute, commandCenterRoute, settingsRoute]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
