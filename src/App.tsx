/* AGPL-3.0-or-later */
import { useQuery } from "@tanstack/react-query";
import { Alert, Box, Button, ScrollArea, Stack, Text } from "@mantine/core";
import { fetchJson } from "@/lib/api";
import { getBannerFromUrl } from "@/lib/dashboard";
import { GoalIntakeCard } from "@/components/GoalIntakeCard";
import { GoalsCard } from "@/components/GoalsCard";
import type { Overview } from "@/types";

// Dashboard = Plan. The single thing the portal exists to do: describe a goal and
// launch it. Runs/Settings/Command Center are their own tabs.
export function App() {
  const overviewQuery = useQuery({
    queryKey: ["overview"],
    queryFn: () => fetchJson<Overview>("/api/overview"),
  });
  const banner = getBannerFromUrl();
  const overview = overviewQuery.data;

  return (
    <Box h="100%" p="md" style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: "var(--mantine-spacing-md)" }}>
      {banner ? (
        <Alert color={banner.includes("failed") ? "red" : "blue"} variant="light" py="xs" style={{ flexShrink: 0 }}>
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

      {/* Plan zone is fixed at top; goal history scrolls below it. */}
      <Box style={{ flexShrink: 0, maxWidth: 760, width: "100%" }}>
        <GoalIntakeCard projects={overview?.projects ?? []} />
      </Box>

      <ScrollArea h="100%" type="auto" style={{ flex: 1, minHeight: 0, maxWidth: 760 }}>
        <Box pr="sm">
          <GoalsCard />
        </Box>
      </ScrollArea>
    </Box>
  );
}
