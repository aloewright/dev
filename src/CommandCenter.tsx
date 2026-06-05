/* AGPL-3.0-or-later */
import { useCallback, useState } from "react";
import { SimpleGrid, Title, Text, Loader, Center, Stack } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { RunCard, type ActiveRun } from "@/RunCard";

interface Overview { recentRuns: Array<ActiveRun & { createdAt: string }> }

export function CommandCenter() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["active-runs"],
    queryFn: () => fetchJson<Overview>("/api/overview"),
    refetchInterval: 5000,
  });

  // Runs that reported a terminal state via SSE this session — cleared immediately
  // rather than waiting for the next /api/overview refetch to drop them.
  const [finished, setFinished] = useState<Set<string>>(new Set());
  const onFinished = useCallback((id: string) => {
    setFinished((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    // Refresh the active list so a freshly-finished run is replaced by whatever runs next.
    void qc.invalidateQueries({ queryKey: ["active-runs"] });
  }, [qc]);

  const active = (query.data?.recentRuns ?? []).filter(
    (r) => ["starting", "queued", "running"].includes(r.status) && !finished.has(r.id),
  );

  return (
    <Stack>
      <Title order={2}>Command Center</Title>
      {query.isLoading && <Center><Loader /></Center>}
      {!query.isLoading && active.length === 0 && (
        <Text c="dimmed">No active runs. Queued and running runs appear here live.</Text>
      )}
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        {active.map((run) => <RunCard key={run.id} run={run} onFinished={onFinished} />)}
      </SimpleGrid>
    </Stack>
  );
}
