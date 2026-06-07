/* AGPL-3.0-or-later */
import { Anchor, Box, Card, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { rowBorder, sectionHeader } from "@/lib/dashboard";
import { EmptyRow, Metric, StatusBadge } from "@/components/primitives";
import type { Overview } from "@/types";

export function QueueCard({ queue }: { queue: Overview["queue"] }) {
  return (
    <Card withBorder radius="md" padding="lg">
      <Title order={2} size="h4" mb="md">
        Queue
      </Title>
      <SimpleGrid cols={2} spacing="md">
        <Metric label="Configured" value={queue.configured ? "yes" : "no"} />
        <Metric label="Pending" value={queue.pendingApproximation} />
      </SimpleGrid>
    </Card>
  );
}

export function TemplatesCard({ templates }: { templates: Overview["templates"] }) {
  return (
    <Card withBorder radius="md" padding={0}>
      <Box px="lg" py="sm" style={sectionHeader}>
        <Title order={2} size="h4">
          Templates
        </Title>
      </Box>
      <Stack gap={0}>
        {templates.map((template) => (
          <Box key={template.id} px="lg" py="sm" style={rowBorder}>
            <Group justify="space-between">
              <Text size="sm" fw={600}>
                {template.kind}
              </Text>
              <StatusBadge status={template.status} />
            </Group>
            <Anchor
              href={`https://github.com/${template.repo}`}
              target="_blank"
              rel="noopener noreferrer"
              size="xs"
              mt={4}
              style={{ wordBreak: "break-all" }}
            >
              {template.repo}
            </Anchor>
          </Box>
        ))}
        {templates.length === 0 ? <EmptyRow label="No templates" /> : null}
      </Stack>
    </Card>
  );
}

export function ArtifactsCard({ artifacts }: { artifacts: Overview["recentArtifacts"] }) {
  return (
    <Card withBorder radius="md" padding={0}>
      <Box px="lg" py="sm" style={sectionHeader}>
        <Title order={2} size="h4">
          Artifacts
        </Title>
      </Box>
      <Stack gap={0}>
        {artifacts.length > 0 ? (
          artifacts.map((artifact) => (
            <Box key={artifact.id} px="lg" py="sm" style={rowBorder}>
              <Text size="sm" fw={600}>
                {artifact.kind}
              </Text>
              <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
                {artifact.url ?? artifact.r2Key}
              </Text>
            </Box>
          ))
        ) : (
          <EmptyRow label="No artifacts written" />
        )}
      </Stack>
    </Card>
  );
}
