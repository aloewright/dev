/* AGPL-3.0-or-later */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Button, Card, FileInput, Group, ScrollArea, Select, Stack, Text, Title } from "@mantine/core";
import { IconUpload } from "@tabler/icons-react";
import { fetchJson } from "@/lib/api";
import { AiRichText } from "@/components/AiRichText";
import type { Overview } from "@/types";

type Core = { soul: string; rules: string };

// Mirror fetchJson's local-dev auth shim for the raw multipart upload.
function uploadHeaders(): HeadersInit {
  if (typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
    return { "x-fly-user": "local-dev" };
  }
  return {};
}

function KnowledgeCard() {
  const overviewQuery = useQuery({ queryKey: ["overview"], queryFn: () => fetchJson<Overview>("/api/overview") });
  const projects = overviewQuery.data?.projects ?? [];
  const [file, setFile] = useState<File | null>(null);
  const [bank, setBank] = useState<string>("global");

  const upload = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append("file", file as File);
      fd.append("projectId", bank);
      const res = await fetch("/api/knowledge", { method: "POST", body: fd, credentials: "same-origin", headers: uploadHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `Upload failed (${res.status})`);
      return body as { file: string; chunks: number; via: string };
    },
    onSuccess: () => setFile(null),
  });

  return (
    <Card withBorder radius="md" padding="lg">
      <Text fw={600} mb={2}>Knowledge base</Text>
      <Text c="dimmed" size="xs" mb="sm">
        Upload PDF, Markdown, text, or images. The text is extracted and added to a Hindsight memory bank so agents can recall it.
      </Text>
      <Stack gap="sm">
        <Select
          label="Add to"
          data={[{ value: "global", label: "Global (all projects)" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
          value={bank}
          onChange={(v) => setBank(v ?? "global")}
          comboboxProps={{ withinPortal: true }}
        />
        <FileInput
          label="File"
          placeholder="Choose a PDF, .md, .txt, .png, or .jpg"
          accept=".pdf,.md,.markdown,.txt,.text,.png,.jpg,.jpeg,application/pdf,text/plain,text/markdown,image/png,image/jpeg"
          value={file}
          onChange={setFile}
          clearable
        />
        <Group justify="space-between">
          {upload.isSuccess ? (
            <Text size="xs" c="teal">Added {upload.data?.chunks} chunk(s) from {upload.data?.file} ({upload.data?.via}).</Text>
          ) : upload.isError ? (
            <Text size="xs" c="red">{(upload.error as Error)?.message ?? "Upload failed"}</Text>
          ) : <span />}
          <Button leftSection={<IconUpload size={14} />} loading={upload.isPending} disabled={!file} onClick={() => upload.mutate()}>
            Upload to memory
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

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
            <Text c="dimmed" size="xs" mb="sm">Identity, values, and guardrails — what "done" means, the quality/security bar, tone, and what to never do. Type <strong>/</strong> for AI generation.</Text>
            {query.data ? (
              <AiRichText value={query.data.soul} onChange={(md) => { setSoul(md); setDirty(true); }} />
            ) : null}
          </Card>

          <Card withBorder radius="md" padding="lg">
            <Text fw={600} mb={2}>Rules</Text>
            <Text c="dimmed" size="xs" mb="sm">Always-follow instructions applied to every run. Type <strong>/</strong> for AI generation.</Text>
            {query.data ? (
              <AiRichText value={query.data.rules} onChange={(md) => { setRules(md); setDirty(true); }} />
            ) : null}
          </Card>

          <Group justify="flex-end" gap="sm">
            {save.isSuccess && !dirty ? <Text size="xs" c="teal">Saved</Text> : null}
            {save.isError ? <Text size="xs" c="red">{(save.error as Error)?.message ?? "Save failed"}</Text> : null}
            <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>Save core</Button>
          </Group>

          <KnowledgeCard />
        </Stack>
      </ScrollArea>
    </Box>
  );
}
