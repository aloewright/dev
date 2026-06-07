/* AGPL-3.0-or-later */
import { useEffect, useRef, useState } from "react";
import { Card, Group, Text, Badge, Button, ScrollArea, Box } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { eventColor } from "@/lib/event-style";

interface RunEvent { id: number; eventType: string; message: string; createdAt: string }
export interface ActiveRun { id: string; objective: string; status: string; projectName: string | null }

const STATUS_COLOR: Record<string, string> = {
  running: "teal", starting: "indigo", queued: "gray", failed: "red", completed: "teal", cancelled: "gray",
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

// Connection state of the live log stream, surfaced so a dropped stream reads as
// "reconnecting" rather than silently freezing the output.
type Conn = "connecting" | "live" | "reconnecting" | "ended";
const CONN_META: Record<Conn, { color: string; label: string }> = {
  connecting: { color: "gray", label: "connecting" },
  live: { color: "teal", label: "live" },
  reconnecting: { color: "yellow", label: "reconnecting…" },
  ended: { color: "gray", label: "stream ended" },
};

export function RunCard({ run, onFinished }: { run: ActiveRun; onFinished?: (id: string) => void }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState(run.status);
  const [conn, setConn] = useState<Conn>("connecting");
  const viewport = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  useEffect(() => {
    const isLocal = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
    const url = `/api/runs/${run.id}/events/stream${isLocal ? "?x-fly-user=local-dev" : ""}`;
    const es = new EventSource(url, { withCredentials: true });
    let ended = false;
    es.onopen = () => setConn("live");
    es.onerror = () => {
      // EventSource auto-reconnects on transient errors unless it has closed.
      if (!ended) setConn(es.readyState === EventSource.CLOSED ? "ended" : "reconnecting");
    };
    es.addEventListener("run_event", (e) => {
      const row = JSON.parse((e as MessageEvent).data) as RunEvent;
      setEvents((prev) => [...prev.slice(-199), row]);
    });
    es.addEventListener("status", (e) => {
      const next = (JSON.parse((e as MessageEvent).data) as { status: string }).status;
      setStatus(next);
      // Once the run reaches a terminal state, drop it from the Command Center immediately.
      if (TERMINAL.has(next)) onFinished?.(run.id);
    });
    es.addEventListener("done", () => {
      ended = true;
      setConn("ended");
      es.close();
      onFinished?.(run.id);
    });
    return () => {
      ended = true;
      es.close();
    };
  }, [run.id, onFinished]);

  useEffect(() => {
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
  }, [events]);

  const cancel = useMutation({
    mutationFn: () => fetchJson(`/api/runs/${run.id}/cancel`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["active-runs"] }),
  });

  return (
    <Card withBorder padding="sm" radius="md">
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Text fw={600} truncate>{run.objective}</Text>
        <Group gap={6} wrap="nowrap">
          {!TERMINAL.has(status) && (
            <Badge size="sm" variant="dot" color={CONN_META[conn].color}>
              {CONN_META[conn].label}
            </Badge>
          )}
          <Badge color={STATUS_COLOR[status] ?? "gray"}>{status}</Badge>
        </Group>
      </Group>
      {run.projectName && <Text size="xs" c="dimmed" mb="xs">{run.projectName}</Text>}
      <ScrollArea h={200} viewportRef={viewport} mb="xs">
        <Box style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, background: "#0d1117", padding: 8, borderRadius: 6 }}>
          {events.length === 0 && (
            <Text size="xs" c="dimmed">
              {conn === "reconnecting"
                ? "Stream dropped — reconnecting…"
                : conn === "ended"
                  ? "Stream ended before any output."
                  : "Waiting for live output…"}
            </Text>
          )}
          {events.map((ev) => (
            <div key={ev.id} style={{ color: eventColor(ev.eventType), whiteSpace: "pre-wrap" }}>
              <span style={{ opacity: 0.6 }}>{ev.eventType}</span> {ev.message}
            </div>
          ))}
        </Box>
      </ScrollArea>
      <Group justify="flex-end">
        <Button size="xs" color="red" variant="light" loading={cancel.isPending} onClick={() => cancel.mutate()}>
          Cancel
        </Button>
      </Group>
    </Card>
  );
}
