/* AGPL-3.0-or-later */
import { useQuery } from "@tanstack/react-query";
import { Alert, Box, Button, Group, Stack, Text, Title } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { IconActivityHeartbeat } from "@tabler/icons-react";
import { fetchJson } from "@/lib/api";
import { getBannerFromUrl } from "@/lib/dashboard";
import { SignInForm } from "@/components/SignInForm";
import { DashboardSkeleton } from "@/components/DashboardSkeleton";
import { GoalIntakeCard } from "@/components/GoalIntakeCard";
import { ActivitySection } from "@/components/ActivitySection";
import { SetupSection } from "@/components/SetupSection";
import type { Overview } from "@/types";

export function App() {
  const overviewQuery = useQuery({
    queryKey: ["overview"],
    queryFn: () => fetchJson<Overview>("/api/overview"),
  });

  const banner = getBannerFromUrl();

  // Login is via Cloudflare Access, so sign-out must clear the Access session.
  function signOut() {
    window.location.href = "/api/access-logout";
  }

  if (overviewQuery.data && !overviewQuery.data.user) {
    return <SignInForm banner={banner} />;
  }

  const overview = overviewQuery.data;

  return (
    // Fills the viewport-bounded AppShell.Main; only the Activity zone scrolls.
    <Box h="100%" p="md" style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: "var(--mantine-spacing-md)" }}>
      <Group justify="space-between" wrap="nowrap" style={{ flexShrink: 0 }}>
        <Box style={{ minWidth: 0 }}>
          <Title order={1} size="h4">dev.fly.pm</Title>
          <Text c="dimmed" size="xs" truncate>
            {overview?.user ? `${overview.user.flyUserSlug} · ${overview.user.authSource}` : "Checking session"}
          </Text>
        </Box>
        <Group gap="xs" wrap="nowrap">
          <Button size="xs" variant="subtle" leftSection={<IconActivityHeartbeat size={15} />} component={Link} to="/command-center">
            Live
          </Button>
          <Button size="xs" variant="default" loading={overviewQuery.isFetching} onClick={() => void overviewQuery.refetch()}>
            Refresh
          </Button>
          {overview?.user ? (
            <Button size="xs" variant="default" onClick={signOut}>Sign out</Button>
          ) : null}
        </Group>
      </Group>

      {banner ? (
        <Alert color={banner.includes("failed") ? "red" : "blue"} variant="light" style={{ flexShrink: 0 }} py="xs">
          {banner}
        </Alert>
      ) : null}

      {overviewQuery.isError && !overview ? (
        <Alert color="red" variant="light" title="Couldn't load your dashboard" style={{ flexShrink: 0 }}>
          <Stack gap="sm" align="flex-start">
            <Text size="sm">{(overviewQuery.error as Error)?.message ?? "Request failed"}</Text>
            <Button size="xs" variant="light" color="red" loading={overviewQuery.isFetching} onClick={() => void overviewQuery.refetch()}>
              Try again
            </Button>
          </Stack>
        </Alert>
      ) : null}

      {!overview && overviewQuery.isLoading ? (
        <Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          <DashboardSkeleton />
        </Box>
      ) : null}

      {overview ? (
        <>
          {/* Zone 1 — Plan & run */}
          <Box style={{ flexShrink: 0 }}>
            <GoalIntakeCard projects={overview.projects} />
          </Box>

          {/* Zone 2 — Activity (fills remaining height, scrolls internally) */}
          <ActivitySection runs={overview.recentRuns} />

          {/* Zone 3 — Setup (collapsible) */}
          <Box style={{ flexShrink: 0 }}>
            <SetupSection projects={overview.projects} repos={overview.repos} connections={overview.connections} />
          </Box>
        </>
      ) : null}
    </Box>
  );
}
