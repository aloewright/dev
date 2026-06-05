/* AGPL-3.0-or-later */
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { App } from "@/App";
import { RootLayout } from "@/AppShell";
import { CommandCenter } from "@/CommandCenter";

const rootRoute = createRootRoute({ component: RootLayout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: App });
const commandCenterRoute = createRoute({ getParentRoute: () => rootRoute, path: "/command-center", component: CommandCenter });

const routeTree = rootRoute.addChildren([indexRoute, commandCenterRoute]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
