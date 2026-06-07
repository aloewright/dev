/* AGPL-3.0-or-later */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Box, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { fetchJson } from "@/lib/api";
import { rowBorder, sectionHeader } from "@/lib/dashboard";
import { EmptyRow, StatusBadge } from "@/components/primitives";
import type { RecentRun } from "@/types";

export function RecentRunsCard({ runs }: { runs: RecentRun[] }) {
  return (
    <Card withBorder radius="md" padding={0}>
      <Box px="lg" py="sm" style={sectionHeader}>
        <Title order={2} size="h4">
          Recent Runs
        </Title>
      </Box>
      <Stack gap={0}>
        {runs.length > 0 ? (
          runs.map((run) => <RunRow key={run.id} run={run} />)
        ) : (
          <EmptyRow label="No runs queued" />
        )}
      </Stack>
    </Card>
  );
}

function useRunAction(runId: string, action: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchJson(`/api/runs/${runId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["overview"] }),
  });
}

function RunRow({ run }: { run: RecentRun }) {
  const approve = useRunAction(run.id, "approve");
  const cancel = useRunAction(run.id, "cancel");
  const retry = useRunAction(run.id, "retry");

  const waiting = run.status === "waiting_approval";
  const active = run.status === "running" || run.status === "queued";

  return (
    <>
      <Group justify="space-between" px="lg" py="sm" style={rowBorder} wrap="wrap">
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Text size="sm" fw={600} truncate>
            {run.objective}
          </Text>
          <Text size="xs" c="dimmed" truncate>
            {run.projectName ?? run.id}
          </Text>
        </Box>
        <Group gap="xs">
          <StatusBadge status={run.status} />
          <StatusBadge status={run.agentProvider} />
        </Group>
        {waiting ? (
          <Group gap="xs">
            <Button size="xs" color="teal" loading={approve.isPending} onClick={() => approve.mutate()}>
              Approve
            </Button>
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              loading={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          </Group>
        ) : (
          <Group gap="xs">
            {!active && (
              <Button
                size="xs"
                variant="light"
                color="indigo"
                leftSection={<IconRefresh style={{ width: 14, height: 14 }} />}
                loading={retry.isPending}
                onClick={() => retry.mutate()}
              >
                Retry
              </Button>
            )}
            <Text size="sm" c="dimmed">
              {run.approvalRequired ? "approval" : active ? run.status : "done"}
            </Text>
          </Group>
        )}
      </Group>

      {approve.error || cancel.error || retry.error ? (
        <Box px="lg" pb="sm">
          <Alert color="red" variant="light" title="Operation failed">
            {approve.error?.message || cancel.error?.message || retry.error?.message}
          </Alert>
        </Box>
      ) : null}
    </>
  );
}
