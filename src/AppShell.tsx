/* AGPL-3.0-or-later */
import { AppShell, NavLink, Title, Box } from "@mantine/core";
import { IconDashboard, IconActivityHeartbeat } from "@tabler/icons-react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";

export function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <AppShell navbar={{ width: 220, breakpoint: "sm" }} padding="md">
      <AppShell.Navbar p="md">
        <Box mb="lg">
          <Title order={4}>Fly Dev</Title>
        </Box>
        <NavLink component={Link} to="/" label="Dashboard" leftSection={<IconDashboard size={18} />} active={pathname === "/"} />
        <NavLink component={Link} to="/command-center" label="Command Center" leftSection={<IconActivityHeartbeat size={18} />} active={pathname === "/command-center"} />
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
