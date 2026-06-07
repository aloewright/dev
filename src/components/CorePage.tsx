/* AGPL-3.0-or-later */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Button, Card, Group, ScrollArea, Stack, Text, Textarea, Title } from "@mantine/core";
import { fetchJson } from "@/lib/api";

type Core = { soul: string; rules: string };

export function CorePage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["core"], queryFn: () => fetchJson<Core>("/api/core") });
  const [soul, setSoul] = useState("");
  const [rules, setRules] = useState("");
  const [dirty, setDirty] = useState(false);

  // Seed the editors once the saved core loads (and on external refetches while clean).
  useEffect(() => {
    if (query.data && !dirty) {
      setSoul(query.data.soul);
      setRules(query.data.rules);
    }
  }, [query.data, dirty]);

  const save = useMutation({
    mutationFn: () =>
      fetchJson<Core>("/api/core", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ soul, rules }),
      }),
    onSuccess: () => {
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ["core"] });
    },
  });

  return (
    <Box h="100%" p="md" style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: "var(--mantine-spacing-sm)" }}>
      <Box style={{ flexShrink: 0 }}>
        <Title order={1} size="h4">Core</Title>
        <Text c="dimmed" size="xs">
          Your soul and rules are injected into every goal breakdown and every run, so agents act with your identity, values, and guardrails.
        </Text>
      </Box>
      <ScrollArea h="100%" type="auto" style={{ flex: 1, minHeight: 0 }}>
        <Stack gap="md" pr="sm" maw={860}>
          <Card withBorder radius="md" padding="lg">
            <Text fw={600} mb={2}>Soul</Text>
            <Text c="dimmed" size="xs" mb="sm">Identity, values, and guardrails — what "done" means, the quality/security bar, tone, and what to never do.</Text>
            <Textarea
              autosize
              minRows={6}
              maxRows={16}
              value={soul}
              onChange={(e) => { setSoul(e.currentTarget.value); setDirty(true); }}
              placeholder={"e.g. You are a senior engineer on the fly platform. Prefer small, well-tested changes. Never touch production secrets or billing. Route all model calls through the Cloudflare AI Gateway, never provider SDKs."}
            />
          </Card>

          <Card withBorder radius="md" padding="lg">
            <Text fw={600} mb={2}>Rules</Text>
            <Text c="dimmed" size="xs" mb="sm">Always-follow instructions applied to every run.</Text>
            <Textarea
              autosize
              minRows={6}
              maxRows={16}
              value={rules}
              onChange={(e) => { setRules(e.currentTarget.value); setDirty(true); }}
              placeholder={"e.g.\n- Always add or update tests for changed code.\n- Use camelCase filenames and alias imports.\n- Keep PRs focused; one concern per PR.\n- Update docs when behavior changes."}
            />
          </Card>

          <Group justify="flex-end" gap="sm">
            {save.isSuccess && !dirty ? <Text size="xs" c="teal">Saved</Text> : null}
            {save.isError ? <Text size="xs" c="red">{(save.error as Error)?.message ?? "Save failed"}</Text> : null}
            <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>Save core</Button>
          </Group>
        </Stack>
      </ScrollArea>
    </Box>
  );
}
