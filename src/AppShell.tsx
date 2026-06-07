/* AGPL-3.0-or-later */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, NavLink, Title, Box, Text, Button, Stack } from "@mantine/core";
import { Spotlight, spotlight, type SpotlightActionData } from "@mantine/spotlight";
import { IconDashboard, IconActivityHeartbeat, IconListDetails, IconSettings, IconBrain, IconTemplate, IconSearch } from "@tabler/icons-react";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { fetchJson } from "@/lib/api";
import { getBannerFromUrl } from "@/lib/dashboard";
import { SignInForm } from "@/components/SignInForm";
import type { Overview } from "@/types";

const NAV = [
  { to: "/", label: "Dashboard", icon: IconDashboard },
  { to: "/runs", label: "Runs", icon: IconListDetails },
  { to: "/command-center", label: "Command Center", icon: IconActivityHeartbeat },
  { to: "/core", label: "Core", icon: IconBrain },
  { to: "/workflows", label: "Workflows", icon: IconTemplate },
  { to: "/settings", label: "Settings", icon: IconSettings },
] as const;

export function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const spotlightActions: SpotlightActionData[] = NAV.map((n) => ({
    id: n.to,
    label: n.label,
    leftSection: <n.icon size={18} />,
    onClick: () => navigate({ to: n.to }),
  }));
  const overviewQuery = useQuery({
    queryKey: ["overview"],
    queryFn: () => fetchJson<Overview>("/api/overview"),
  });
  const overview = overviewQuery.data;

  // Auth gate lives at the shell so every tab is behind it.
  if (overview && !overview.user) {
    return <SignInForm banner={getBannerFromUrl()} />;
  }

  function signOut() {
    window.location.href = "/api/access-logout";
  }

  return (
    // h=100dvh + padding=0 makes the shell exactly viewport-tall; each page owns its
    // own scroll containment so the app fits the viewport.
    <AppShell navbar={{ width: 210, breakpoint: "sm" }} padding={0} h="100dvh">
      <AppShell.Navbar p="md">
        <Stack h="100%" gap={4}>
          <Box mb="sm">
            <Title order={4}>Fly Dev</Title>
          </Box>
          <Button
            variant="default"
            size="xs"
            justify="space-between"
            leftSection={<IconSearch size={14} />}
            rightSection={<Text size="xs" c="dimmed">⌘K</Text>}
            onClick={() => spotlight.open()}
            mb="xs"
          >
            Search
          </Button>
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              component={Link}
              to={n.to}
              label={n.label}
              leftSection={<n.icon size={18} />}
              active={pathname === n.to}
            />
          ))}
          <Box style={{ marginTop: "auto" }} pt="md">
            <Text size="xs" c="dimmed" truncate mb="xs">
              {overview?.user ? (overview.user.name || overview.user.email || "Signed in") : "Checking session"}
            </Text>
            <Button size="xs" variant="default" fullWidth mb={6} loading={overviewQuery.isFetching} onClick={() => void queryClient.invalidateQueries({ queryKey: ["overview"] })}>
              Refresh
            </Button>
            {overview?.user ? (
              <Button size="xs" variant="subtle" color="gray" fullWidth onClick={signOut}>Sign out</Button>
            ) : null}
          </Box>
        </Stack>
      </AppShell.Navbar>
      <AppShell.Main style={{ height: "100dvh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <Outlet />
      </AppShell.Main>
      <Spotlight
        actions={spotlightActions}
        shortcut="mod + K"
        nothingFound="Nothing found"
        searchProps={{ placeholder: "Jump to…", leftSection: <IconSearch size={18} /> }}
      />
    </AppShell>
  );
}
