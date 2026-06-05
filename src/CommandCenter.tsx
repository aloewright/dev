/* AGPL-3.0-or-later */
import { SimpleGrid, Title, Text, Loader, Center, Stack } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { RunCard, type ActiveRun } from "@/RunCard";

interface Overview { recentRuns: Array<ActiveRun & { createdAt: string }> }

export function CommandCenter() {
  const query = useQuery({
    queryKey: ["active-runs"],
    queryFn: () => fetchJson<Overview>("/api/overview"),
    refetchInterval: 5000,
  });
  const active = (query.data?.recentRuns ?? []).filter((r) => ["starting", "queued", "running"].includes(r.status));
  return (
    <Stack>
      <Title order={2}>Command Center</Title>
      {query.isLoading && <Center><Loader /></Center>}
      {!query.isLoading && active.length === 0 && (
        <Text c="dimmed">No active runs. Queued and running runs appear here live.</Text>
      )}
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        {active.map((run) => <RunCard key={run.id} run={run} />)}
      </SimpleGrid>
    </Stack>
  );
}
