/* AGPL-3.0-or-later */
import { AppShell, NavLink, Title, Box } from "@mantine/core";
import { IconDashboard, IconActivityHeartbeat } from "@tabler/icons-react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";

export function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    // h=100dvh + padding=0 makes the shell exactly viewport-tall; Main owns its own
    // scroll containment so the dashboard fits the viewport instead of the whole
    // page scrolling.
    <AppShell navbar={{ width: 200, breakpoint: "sm" }} padding={0} h="100dvh">
      <AppShell.Navbar p="md">
        <Box mb="lg">
          <Title order={4}>Fly Dev</Title>
        </Box>
        <NavLink component={Link} to="/" label="Dashboard" leftSection={<IconDashboard size={18} />} active={pathname === "/"} />
        <NavLink component={Link} to="/command-center" label="Command Center" leftSection={<IconActivityHeartbeat size={18} />} active={pathname === "/command-center"} />
      </AppShell.Navbar>
      <AppShell.Main style={{ height: "100dvh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
