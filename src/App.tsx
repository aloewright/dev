/* AGPL-3.0-or-later */
import { useQuery } from "@tanstack/react-query";
import { Alert, Box, Button, Container, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { fetchJson } from "@/lib/api";
import { getBannerFromUrl } from "@/lib/dashboard";
import { Metric } from "@/components/primitives";
import { SignInForm } from "@/components/SignInForm";
import { DashboardSkeleton } from "@/components/DashboardSkeleton";
import { GoalIntakeCard } from "@/components/GoalIntakeCard";
import { ProjectsCard } from "@/components/ProjectsCard";
import { ReposCard } from "@/components/ReposCard";
import { ConnectionsCard } from "@/components/ConnectionsCard";
import { GoalsCard } from "@/components/GoalsCard";
import { RecentRunsCard } from "@/components/RecentRunsCard";
import { QueueCard, TemplatesCard, ArtifactsCard } from "@/components/SidePanels";
import type { Overview } from "@/types";

export function App() {
  const overviewQuery = useQuery({
    queryKey: ["overview"],
    queryFn: () => fetchJson<Overview>("/api/overview"),
  });

  const banner = getBannerFromUrl();

  // Login is via Cloudflare Access, so sign-out must clear the Access session,
  // not the unused better-auth one. Full-page navigate to /api/access-logout.
  function signOut() {
    window.location.href = "/api/access-logout";
  }

  if (overviewQuery.data && !overviewQuery.data.user) {
    return <SignInForm banner={banner} />;
  }

  const overview = overviewQuery.data;

  return (
    <Box mih="100vh" bg="var(--mantine-color-body)">
      <Box
        component="header"
        bg="var(--mantine-color-default)"
        style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
      >
        <Container size="xl" py="md">
          <Group justify="space-between" wrap="wrap">
            <Box>
              <Title order={1} size="h3">
                dev.fly.pm
              </Title>
              <Text c="dimmed" size="sm">
                {overview?.user
                  ? `${overview.user.flyUserSlug} · ${overview.user.authSource}`
                  : "Checking session"}
              </Text>
            </Box>
            <Group gap="xs">
              <Button
                variant="default"
                loading={overviewQuery.isFetching}
                onClick={() => void overviewQuery.refetch()}
              >
                Refresh
              </Button>
              {overview?.user ? (
                <Button variant="default" onClick={signOut}>
                  Sign out
                </Button>
              ) : null}
            </Group>
          </Group>
        </Container>
      </Box>

      <Container size="xl" py="md">
        {banner ? (
          <Alert color={banner.includes("failed") ? "red" : "blue"} variant="light" mb="md">
            {banner}
          </Alert>
        ) : null}

        {overviewQuery.isError && !overview ? (
          <Alert color="red" variant="light" title="Couldn't load your dashboard" mb="md">
            <Stack gap="sm" align="flex-start">
              <Text size="sm">{(overviewQuery.error as Error)?.message ?? "Request failed"}</Text>
              <Button
                size="xs"
                variant="light"
                color="red"
                loading={overviewQuery.isFetching}
                onClick={() => void overviewQuery.refetch()}
              >
                Try again
              </Button>
            </Stack>
          </Alert>
        ) : null}

        {!overview && overviewQuery.isLoading ? <DashboardSkeleton /> : null}

        {overview ? (
          <SimpleGrid cols={{ base: 1, xl: 2 }} spacing="lg">
            <Stack gap="lg">
              <SimpleGrid cols={{ base: 2, lg: 4 }} spacing="md">
                <Metric label="Usage events" value={overview.usage.events} />
                <Metric label="Model calls" value={overview.usage.modelCalls} />
                <Metric label="Container min" value={overview.usage.containerMinutes} />
                <Metric label="Deploys" value={overview.usage.deploys} />
              </SimpleGrid>

              <GoalIntakeCard projects={overview.projects} />
              <ProjectsCard projects={overview.projects} repos={overview.repos} />
              <ReposCard repos={overview.repos} />
            </Stack>

            <Stack gap="lg">
              <ConnectionsCard connections={overview.connections} />
              <GoalsCard />
              <RecentRunsCard runs={overview.recentRuns} />
              <QueueCard queue={overview.queue} />
              <TemplatesCard templates={overview.templates} />
              <ArtifactsCard artifacts={overview.recentArtifacts} />
            </Stack>
          </SimpleGrid>
        ) : null}
      </Container>
    </Box>
  );
}
