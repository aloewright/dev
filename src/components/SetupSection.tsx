/* AGPL-3.0-or-later */
import { useState } from "react";
import { Badge, Box, Group, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconSettings } from "@tabler/icons-react";
import { sectionHeader } from "@/lib/dashboard";
import { ProjectsCard } from "@/components/ProjectsCard";
import { ConnectionsCard } from "@/components/ConnectionsCard";
import type { Overview, Project, Repo } from "@/types";

// Compact, collapsible "Setup" zone: integration connections + project→repo
// mapping. Collapsed by default once the essentials are wired so it doesn't eat
// vertical space; auto-opens when something needed for runs is missing.
export function SetupSection({
  projects,
  repos,
  connections,
}: {
  projects: Project[];
  repos: Repo[];
  connections: Overview["connections"];
}) {
  const githubOk = connections.some((c) => c.provider === "github" && c.status === "connected");
  const linearOk = connections.some((c) => c.provider === "linear" && c.status === "connected");
  const mapped = projects.filter((p) => p.repoUrl).length;
  const needsSetup = !githubOk || !linearOk || mapped === 0;
  const [open, setOpen] = useState(needsSetup);

  return (
    <Box style={{ ...sectionHeader, borderBottom: undefined, border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)" }}>
      <UnstyledButton onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="setup-panel" w="100%">
        <Group justify="space-between" px="md" py="xs" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            {open ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
            <IconSettings size={15} style={{ color: "var(--mantine-color-dimmed)" }} />
            <Text size="sm" fw={600}>Setup</Text>
          </Group>
          <Group gap={6} wrap="nowrap">
            <Badge size="sm" variant="light" color={githubOk ? "teal" : "red"}>GitHub {githubOk ? "✓" : "—"}</Badge>
            <Badge size="sm" variant="light" color={linearOk ? "teal" : "red"}>Linear {linearOk ? "✓" : "—"}</Badge>
            <Badge size="sm" variant="light" color={mapped ? "teal" : "orange"}>{mapped} repo{mapped === 1 ? "" : "s"} mapped</Badge>
          </Group>
        </Group>
      </UnstyledButton>
      {open ? (
        <ScrollArea.Autosize mah="42vh" px="md" pb="md" id="setup-panel">
          <Stack gap="md">
            <ProjectsCard projects={projects} repos={repos} />
            <ConnectionsCard connections={connections} />
          </Stack>
        </ScrollArea.Autosize>
      ) : null}
    </Box>
  );
}
