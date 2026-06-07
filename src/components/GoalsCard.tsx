/* AGPL-3.0-or-later */
import { useQuery } from "@tanstack/react-query";
import { Box, Card, Group, Stack, Text, Title } from "@mantine/core";
import { fetchJson } from "@/lib/api";
import { rowBorder, sectionHeader } from "@/lib/dashboard";
import { EmptyRow, StatusBadge } from "@/components/primitives";

type GoalSummary = {
  id: string;
  objective: string;
  summary: string | null;
  status: string;
  issueCount: number;
  runCount: number;
  createdAt: string;
  projectName: string | null;
};

export function GoalsCard() {
  const query = useQuery({
    queryKey: ["goals"],
    queryFn: () => fetchJson<{ goals: GoalSummary[] }>("/api/goals"),
  });
  const goals = query.data?.goals ?? [];

  return (
    <Card withBorder radius="md" padding={0}>
      <Box px="lg" py="sm" style={sectionHeader}>
        <Title order={2} size="h4">
          Goals
        </Title>
      </Box>
      <Stack gap={0}>
        {goals.length > 0 ? (
          goals.map((goal) => (
            <Box key={goal.id} px="lg" py="sm" style={rowBorder}>
              <Group justify="space-between" wrap="nowrap" gap="sm">
                <Box style={{ minWidth: 0, flex: 1 }}>
                  <Text size="sm" fw={600} truncate>
                    {goal.objective}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    {goal.projectName ?? "no project"} · {goal.issueCount} issues · {goal.runCount} runs
                  </Text>
                </Box>
                <StatusBadge status={goal.status} />
              </Group>
            </Box>
          ))
        ) : (
          <EmptyRow label="No goals yet — submit one in Goal Intake" />
        )}
      </Stack>
    </Card>
  );
}
