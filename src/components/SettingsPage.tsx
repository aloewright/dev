/* AGPL-3.0-or-later */
import { useQuery } from "@tanstack/react-query";
import { Box, ScrollArea, Stack, Text, Title } from "@mantine/core";
import { fetchJson } from "@/lib/api";
import { ProjectsCard } from "@/components/ProjectsCard";
import { ConnectionsCard } from "@/components/ConnectionsCard";
import type { Overview } from "@/types";

export function SettingsPage() {
  const query = useQuery({
    queryKey: ["overview"],
    queryFn: () => fetchJson<Overview>("/api/overview"),
  });
  const overview = query.data;

  return (
    <Box h="100%" p="md" style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: "var(--mantine-spacing-sm)" }}>
      <Box style={{ flexShrink: 0 }}>
        <Title order={1} size="h4">Settings</Title>
        <Text c="dimmed" size="xs">Connect integrations and map each Linear project to a GitHub repo.</Text>
      </Box>
      <ScrollArea h="100%" type="auto" style={{ flex: 1, minHeight: 0 }}>
        <Stack gap="md" pr="sm" maw={900}>
          <ConnectionsCard connections={overview?.connections ?? []} />
          <ProjectsCard projects={overview?.projects ?? []} repos={overview?.repos ?? []} />
        </Stack>
      </ScrollArea>
    </Box>
  );
}
