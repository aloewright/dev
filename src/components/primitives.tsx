/* AGPL-3.0-or-later */
import { Badge, Box, Paper, Text } from "@mantine/core";

export function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <Paper withBorder radius="md" p="md">
      <Text size="xs" fw={600} tt="uppercase" c="dimmed">
        {label}
      </Text>
      <Text size="xl" fw={700} mt={4}>
        {value}
      </Text>
    </Paper>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.replaceAll("_", " ");
  const color =
    status.includes("failed") || status.includes("error")
      ? "red"
      : status === "connected" || status === "active" || status === "mapped"
        ? "teal"
        : "indigo";
  // Text carries the meaning too (not color alone) and aria-label spells out the
  // status so it isn't read as a bare word out of context.
  return (
    <Badge color={color} variant="light" tt="none" aria-label={`Status: ${normalized}`}>
      {normalized}
    </Badge>
  );
}

export function EmptyRow({ label }: { label: string }) {
  return (
    <Box px="lg" py="xl">
      <Text c="dimmed" size="sm">
        {label}
      </Text>
    </Box>
  );
}
