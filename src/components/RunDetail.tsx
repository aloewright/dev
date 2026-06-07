/* AGPL-3.0-or-later */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Anchor, Box, Button, Group, ScrollArea, Stack, Text } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { fetchJson } from "@/lib/api";
import { eventColor } from "@/lib/event-style";
import { StatusBadge } from "@/components/primitives";
import type { RecentRun } from "@/types";

type RunEvent = {
  id: number;
  eventType: string;
  message: string | null;
  severity: string;
  metadataJson: string | null;
  createdAt: string;
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function useRunAction(runId: string, action: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchJson(`/api/runs/${runId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["overview"] });
      void qc.invalidateQueries({ queryKey: ["run-events", runId] });
    },
  });
}

// Pull a useful link/field out of an event's metadata for the timeline (PR url,
// failure reason, error class, etc.) without dumping raw JSON.
function metaSummary(metadataJson: string | null): { prUrl?: string; text?: string } {
  if (!metadataJson) return {};
  try {
    const m = JSON.parse(metadataJson) as Record<string, unknown>;
    const prUrl = typeof m.prUrl === "string" ? m.prUrl : undefined;
    const text =
      [m.reason, m.errorClass, m.mergeReason, m.summary, m.provider, m.model]
        .filter((v) => typeof v === "string" && v)
        .join(" · ") || undefined;
    return { prUrl, text };
  } catch {
    return {};
  }
}

export function RunDetail({ run }: { run: RecentRun }) {
  const live = !TERMINAL.has(run.status);
  const eventsQuery = useQuery({
    queryKey: ["run-events", run.id],
    queryFn: () => fetchJson<{ events: RunEvent[] }>(`/api/runs/${run.id}/events`),
    refetchInterval: live ? 4000 : false,
  });
  const events = eventsQuery.data?.events ?? [];
  const prUrl = events.map((e) => metaSummary(e.metadataJson).prUrl).find(Boolean);

  const waiting = run.status === "waiting_approval";
  const active = run.status === "running" || run.status === "queued";
  const approve = useRunAction(run.id, "approve");
  const cancel = useRunAction(run.id, "cancel");
  const retry = useRunAction(run.id, "retry");

  return (
    <Stack gap="sm" h="100%" style={{ minHeight: 0 }}>
      <Box style={{ flexShrink: 0 }}>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Box style={{ minWidth: 0 }}>
            <Text fw={600} lineClamp={2}>{run.objective}</Text>
            <Group gap="xs" mt={4}>
              <StatusBadge status={run.status} />
              <StatusBadge status={run.agentProvider} />
              <Text size="xs" c="dimmed">{run.projectName ?? run.id}</Text>
            </Group>
          </Box>
          <Group gap="xs" wrap="nowrap">
            {waiting ? (
              <>
                <Button size="xs" color="teal" loading={approve.isPending} onClick={() => approve.mutate()}>Approve</Button>
                <Button size="xs" variant="subtle" color="gray" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel</Button>
              </>
            ) : active ? (
              <Button size="xs" variant="subtle" color="gray" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel</Button>
            ) : (
              <Button size="xs" variant="light" color="indigo" leftSection={<IconRefresh size={14} />} loading={retry.isPending} onClick={() => retry.mutate()}>Retry</Button>
            )}
          </Group>
        </Group>
        {prUrl ? (
          <Anchor href={prUrl} target="_blank" rel="noopener noreferrer" size="sm" mt={6} style={{ display: "inline-block" }}>
            View pull request ↗
          </Anchor>
        ) : null}
        {run.lastError ? (
          <Alert color="red" variant="light" mt="xs" py={6}><Text size="xs">{run.lastError}</Text></Alert>
        ) : null}
      </Box>

      <ScrollArea h="100%" type="auto" style={{ flex: 1, minHeight: 0 }}>
        <Box style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
          {eventsQuery.isLoading ? (
            <Text size="xs" c="dimmed">Loading timeline…</Text>
          ) : events.length === 0 ? (
            <Text size="xs" c="dimmed">No events recorded for this run.</Text>
          ) : (
            <Stack gap={2}>
              {events.map((ev) => {
                const { text } = metaSummary(ev.metadataJson);
                const time = ev.createdAt.slice(11, 19);
                return (
                  <Group key={ev.id} gap={8} wrap="nowrap" align="flex-start">
                    <Text span size="xs" c="dimmed" style={{ flexShrink: 0 }}>{time}</Text>
                    <Text span size="xs" style={{ color: eventColor(ev.eventType), flexShrink: 0, minWidth: 110 }}>{ev.eventType}</Text>
                    <Text span size="xs" style={{ wordBreak: "break-word", color: ev.severity === "error" ? "var(--mantine-color-red-4)" : undefined }}>
                      {ev.message || text || ""}
                      {ev.message && text ? <Text span c="dimmed"> — {text}</Text> : null}
                    </Text>
                  </Group>
                );
              })}
            </Stack>
          )}
        </Box>
      </ScrollArea>
    </Stack>
  );
}
