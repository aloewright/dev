/* AGPL-3.0-or-later */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Button, Card, Group, ScrollArea, Stack, Text, TextInput, Textarea, Title, UnstyledButton } from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { fetchJson } from "@/lib/api";
import { rowBorder } from "@/lib/dashboard";
import { EmptyRow } from "@/components/primitives";

type Workflow = { id: string; name: string; description: string; template: string; updatedAt?: string };

const BLANK: Workflow = { id: "", name: "", description: "", template: "" };

export function WorkflowsPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["workflows"], queryFn: () => fetchJson<{ workflows: Workflow[] }>("/api/workflows") });
  const workflows = query.data?.workflows ?? [];
  const [draft, setDraft] = useState<Workflow | null>(null);

  // Default selection to the first workflow once loaded (or a blank new one).
  useEffect(() => {
    if (!draft && workflows[0]) setDraft(workflows[0]);
  }, [workflows, draft]);

  const save = useMutation({
    mutationFn: (wf: Workflow) =>
      fetchJson<Workflow>("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: wf.id || undefined, name: wf.name, description: wf.description, template: wf.template }),
      }),
    onSuccess: (saved) => {
      setDraft(saved);
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => fetchJson(`/api/workflows/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setDraft({ ...BLANK });
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
  });

  return (
    <Box h="100%" p="md" style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: "var(--mantine-spacing-sm)" }}>
      <Group justify="space-between" style={{ flexShrink: 0 }}>
        <Box>
          <Title order={1} size="h4">Workflows</Title>
          <Text c="dimmed" size="xs">Reusable goal templates. Use {"{placeholders}"} for parts you fill in at launch.</Text>
        </Box>
        <Button size="xs" leftSection={<IconPlus size={14} />} variant="light" onClick={() => setDraft({ ...BLANK })}>New</Button>
      </Group>

      <Box style={{ flex: 1, minHeight: 0, display: "flex", gap: "var(--mantine-spacing-md)" }}>
        <Card withBorder radius="md" padding={0} style={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <ScrollArea h="100%" type="auto">
            <Stack gap={0}>
              {workflows.length === 0 ? (
                <EmptyRow label="No workflows yet — create one." />
              ) : (
                workflows.map((wf) => (
                  <UnstyledButton
                    key={wf.id}
                    onClick={() => setDraft(wf)}
                    px="md"
                    py="sm"
                    w="100%"
                    style={{ ...rowBorder, background: draft?.id === wf.id ? "var(--mantine-color-default-hover)" : undefined }}
                  >
                    <Text size="sm" fw={600} truncate>{wf.name}</Text>
                    {wf.description ? <Text size="xs" c="dimmed" truncate>{wf.description}</Text> : null}
                  </UnstyledButton>
                ))
              )}
            </Stack>
          </ScrollArea>
        </Card>

        <Card withBorder radius="md" padding="lg" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {draft ? (
            <ScrollArea h="100%" type="auto">
              <Stack gap="sm" pr="sm">
                <TextInput label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })} placeholder="e.g. Add CRUD endpoint" />
                <TextInput label="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.currentTarget.value })} placeholder="When to use this" />
                <Textarea
                  label="Template"
                  description="The goal text. Use {placeholders} for fill-ins."
                  autosize
                  minRows={6}
                  maxRows={18}
                  value={draft.template}
                  onChange={(e) => setDraft({ ...draft, template: e.currentTarget.value })}
                  placeholder={"Add a CRUD endpoint for {entity} with input validation and tests. Follow existing route conventions and update the OpenAPI spec."}
                />
                <Group justify="space-between">
                  {draft.id ? (
                    <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} loading={remove.isPending} onClick={() => remove.mutate(draft.id)}>Delete</Button>
                  ) : <span />}
                  <Button loading={save.isPending} disabled={!draft.name.trim()} onClick={() => save.mutate(draft)}>{draft.id ? "Save" : "Create"}</Button>
                </Group>
                {save.isError ? <Text size="xs" c="red">{(save.error as Error)?.message ?? "Save failed"}</Text> : null}
              </Stack>
            </ScrollArea>
          ) : (
            <Text c="dimmed" size="sm">Select a workflow or create a new one.</Text>
          )}
        </Card>
      </Box>
    </Box>
  );
}
