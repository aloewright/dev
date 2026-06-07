/* AGPL-3.0-or-later */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Box, Card, Group, ScrollArea, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { fetchJson } from "@/lib/api";
import { rowBorder } from "@/lib/dashboard";
import { StatusBadge, EmptyRow } from "@/components/primitives";
import { RunDetail } from "@/components/RunDetail";
import type { Overview, RecentRun } from "@/types";

export function RunsPage() {
  const query = useQuery({
    queryKey: ["overview"],
    queryFn: () => fetchJson<Overview>("/api/overview"),
    refetchInterval: 5000,
  });
  const runs = query.data?.recentRuns ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const current = runs.find((r) => r.id === selectedId) ?? runs[0];

  return (
    <Box h="100%" p="md" style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: "var(--mantine-spacing-sm)" }}>
      <Title order={1} size="h4" style={{ flexShrink: 0 }}>Runs</Title>
      <Box style={{ flex: 1, minHeight: 0, display: "flex", gap: "var(--mantine-spacing-md)" }}>
        {/* Master: run list */}
        <Card withBorder radius="md" padding={0} style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <ScrollArea h="100%" type="auto">
            <Stack gap={0}>
              {runs.length === 0 ? (
                <EmptyRow label="No runs yet — launch a goal from the Dashboard." />
              ) : (
                runs.map((run) => (
                  <RunListItem
                    key={run.id}
                    run={run}
                    selected={current?.id === run.id}
                    onSelect={() => setSelectedId(run.id)}
                  />
                ))
              )}
            </Stack>
          </ScrollArea>
        </Card>

        {/* Detail: what happened during the selected run */}
        <Card withBorder radius="md" padding="md" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {current ? (
            <RunDetail run={current} />
          ) : (
            <Text c="dimmed" size="sm">Select a run to see what happened.</Text>
          )}
        </Card>
      </Box>
    </Box>
  );
}

function RunListItem({ run, selected, onSelect }: { run: RecentRun; selected: boolean; onSelect: () => void }) {
  return (
    <UnstyledButton
      onClick={onSelect}
      style={{
        ...rowBorder,
        background: selected ? "var(--mantine-color-default-hover)" : undefined,
      }}
      px="md"
      py="sm"
      w="100%"
    >
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="sm" fw={600} truncate style={{ minWidth: 0, flex: 1 }}>{run.objective}</Text>
        <StatusBadge status={run.status} />
      </Group>
      <Text size="xs" c="dimmed" truncate>{run.projectName ?? run.createdAt.slice(0, 16).replace("T", " ")}</Text>
    </UnstyledButton>
  );
}
