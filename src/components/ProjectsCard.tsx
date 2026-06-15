/* AGPL-3.0-or-later */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Loader,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconRefresh } from "@tabler/icons-react";
import { fetchJson } from "@/lib/api";
import { AGENT_PROVIDER_OPTIONS, type AgentProvider } from "@/lib/agentProviders";
import { PRIORITY_LABELS, rowBorder, sectionHeader } from "@/lib/dashboard";
import { EmptyRow, StatusBadge } from "@/components/primitives";
import type { ContinueResult, LinearIssue, Project, Repo, TodoExecutionResult } from "@/types";

export function ProjectsCard({ projects, repos }: { projects: Project[]; repos: Repo[] }) {
  const queryClient = useQueryClient();
  const autoMap = useMutation({
    mutationFn: () =>
      fetchJson<{ mapped: number; needsReview: number; unmapped: number }>(
        "/api/projects/auto-map",
        { method: "POST", headers: { "content-type": "application/json" } },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  return (
    <Card withBorder radius="md" padding={0}>
      <Box px="lg" py="sm" style={sectionHeader}>
        <Group justify="space-between">
          <Title order={2} size="h4">
            Linear Projects
          </Title>
          <Button size="xs" variant="light" loading={autoMap.isPending} onClick={() => autoMap.mutate()}>
            Auto-map repos
          </Button>
        </Group>
      </Box>
      <Stack gap={0}>
        {projects.map((project) => (
          <ProjectRow key={project.id} project={project} repos={repos} />
        ))}
        {projects.length === 0 ? <EmptyRow label="No projects" /> : null}
      </Stack>
    </Card>
  );
}

function ProjectRow({ project, repos }: { project: Project; repos: Repo[] }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  // Open issues are fetched live (never stored) and only when the row is
  // expanded, so collapsed projects cost nothing.
  const issuesQuery = useQuery({
    queryKey: ["issues", project.id],
    queryFn: () =>
      fetchJson<{ issues: LinearIssue[]; reason?: string }>(`/api/projects/${project.id}/issues`),
    enabled: expanded,
  });

  const issues = issuesQuery.data?.issues ?? [];

  // Manual repo mapping: pick a synced repo (or clear). The current mapping is
  // matched back to a repo id via its URL so the Select shows the active value.
  const currentRepoId = repos.find((repo) => repo.url === project.repoUrl)?.id ?? null;
  const setMapping = useMutation({
    mutationFn: (repoId: string | null) =>
      fetchJson("/api/projects/" + project.id + "/mapping", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(repoId ? { repoId } : { clear: true }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  const [confirming, setConfirming] = useState(false);
  const [agentProvider, setAgentProvider] = useState<AgentProvider>("claude-code");
  const continueMutation = useMutation({
    mutationFn: () =>
      fetchJson<ContinueResult>(`/api/projects/${project.id}/continue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentProvider }),
      }),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["issues", project.id] });
    },
  });

  const executeTodosMutation = useMutation({
    mutationFn: () =>
      fetchJson<TodoExecutionResult>(`/api/projects/${project.id}/execute-todos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentProvider }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["issues", project.id] });
    },
  });

  const panelId = `project-panel-${project.id}`;

  return (
    <Box style={rowBorder}>
      <UnstyledButton
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={`${expanded ? "Collapse" : "Expand"} project ${project.name}`}
        w="100%"
      >
        <Group justify="space-between" px="lg" py="sm" wrap="wrap">
          <Box style={{ minWidth: 0, flex: 1 }}>
            <Group gap="xs" wrap="nowrap">
              {expanded ? (
                <IconChevronDown size={14} style={{ color: "var(--mantine-color-dimmed)" }} />
              ) : (
                <IconChevronRight size={14} style={{ color: "var(--mantine-color-dimmed)" }} />
              )}
              <Text size="sm" fw={600} truncate>
                {project.name}
              </Text>
            </Group>
            <Text size="xs" c="dimmed" truncate ml={18}>
              {project.repoUrl ?? project.url ?? "repository pending"}
            </Text>
          </Box>
          <Group gap="xs">
            <StatusBadge status={project.status} />
            <StatusBadge status={project.repoMappingStatus} />
          </Group>
          <Text size="sm" c="dimmed">
            {project.activeRuns} active · {project.failedRuns} failed
          </Text>
        </Group>
      </UnstyledButton>

      {expanded ? (
        <Box px="lg" pb="sm" pl={32} id={panelId}>
          <Group gap="xs" align="flex-end" pb="sm" wrap="nowrap">
            <Select
              label="GitHub repo"
              placeholder={repos.length ? "Search repos…" : "Sync GitHub first"}
              data={repos.map((repo) => ({ value: repo.id, label: repo.fullName }))}
              value={currentRepoId}
              onChange={(value) => setMapping.mutate(value)}
              searchable
              clearable
              disabled={repos.length === 0 || setMapping.isPending}
              size="xs"
              style={{ flex: 1, minWidth: 0 }}
              comboboxProps={{ withinPortal: true }}
            />
            {!currentRepoId && project.suggestedRepo ? (
              <Button
                size="xs"
                variant="light"
                loading={setMapping.isPending}
                onClick={() => {
                  const suggested = repos.find((repo) => repo.fullName === project.suggestedRepo);
                  if (suggested) setMapping.mutate(suggested.id);
                }}
              >
                Use {project.suggestedRepo}
              </Button>
            ) : null}
          </Group>

          <Group gap="xs" align="center" pb="xs" wrap="wrap">
            <SegmentedControl
              size="xs"
              data={AGENT_PROVIDER_OPTIONS}
              value={agentProvider}
              onChange={(value) => setAgentProvider(value as AgentProvider)}
            />
            {confirming ? (
              <>
                <Text size="xs" c="dimmed">
                  Creates Linear issues and starts runs.
                </Text>
                <Button
                  size="xs"
                  color="teal"
                  loading={continueMutation.isPending}
                  onClick={() => continueMutation.mutate()}
                >
                  Confirm
                </Button>
                <Button size="xs" variant="subtle" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="xs" onClick={() => setConfirming(true)}>
                Continue ▶
              </Button>
            )}
            <Button
              size="xs"
              variant="light"
              leftSection={<IconRefresh size={14} />}
              loading={executeTodosMutation.isPending}
              onClick={() => executeTodosMutation.mutate()}
            >
              Refresh To Dos
            </Button>
          </Group>

          {continueMutation.error ? (
            <Text size="xs" c="red" pb="xs" role="alert">
              {(continueMutation.error as Error).message}
            </Text>
          ) : null}

          {executeTodosMutation.error ? (
            <Text size="xs" c="red" pb="xs" role="alert">
              {(executeTodosMutation.error as Error).message}
            </Text>
          ) : null}

          {executeTodosMutation.data ? (
            <Text size="xs" c="dimmed" pb="xs">
              {todoExecutionSummary(executeTodosMutation.data)}
            </Text>
          ) : null}

          {continueMutation.data ? (
            <Stack gap={4} pb="xs">
              {continueMutation.data.summary ? (
                <Text size="xs" c="dimmed">
                  {continueMutation.data.summary}
                </Text>
              ) : null}
              {continueMutation.data.createdIssues.map((iss) => (
                <Anchor
                  key={iss.id}
                  href={iss.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="xs"
                  truncate
                >
                  <Text component="span" size="xs" c="dimmed" mr={6}>
                    {iss.identifier}
                  </Text>
                  {iss.title}
                </Anchor>
              ))}
              <Text size="xs" c="dimmed">
                {continueMutation.data.queuedRuns.length} run(s) started ·{" "}
                {continueMutation.data.skipped} issue(s) queued
              </Text>
            </Stack>
          ) : null}

          {issuesQuery.isLoading ? (
            <Group gap="xs" py="xs">
              <Loader size="xs" />
              <Text size="xs" c="dimmed">
                Loading open issues…
              </Text>
            </Group>
          ) : issuesQuery.isError ? (
            <Text size="xs" c="red" py="xs" role="alert">
              Failed to load issues. {(issuesQuery.error as Error)?.message}
            </Text>
          ) : issuesQuery.data?.reason ? (
            <Text size="xs" c="dimmed" py="xs">
              {issuesQuery.data.reason}
            </Text>
          ) : issues.length === 0 ? (
            <Text size="xs" c="dimmed" py="xs">
              No open issues.
            </Text>
          ) : (
            <Stack gap={4} pt="xs">
              {issues.map((issue) => (
                <Group key={issue.id} justify="space-between" wrap="nowrap" gap="sm">
                  <Box style={{ minWidth: 0, flex: 1 }}>
                    <Anchor
                      href={issue.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      size="sm"
                      truncate
                      style={{ display: "block" }}
                    >
                      <Text component="span" size="xs" c="dimmed" mr={6}>
                        {issue.identifier}
                      </Text>
                      {issue.title}
                    </Anchor>
                    {issue.assignee ? (
                      <Text size="xs" c="dimmed">
                        {issue.assignee}
                      </Text>
                    ) : null}
                  </Box>
                  <Group gap={6} wrap="nowrap">
                    {PRIORITY_LABELS[issue.priority] ? (
                      <Badge size="xs" variant="outline" color="gray" tt="none">
                        {PRIORITY_LABELS[issue.priority]}
                      </Badge>
                    ) : null}
                    <StatusBadge status={issue.state} />
                  </Group>
                </Group>
              ))}
            </Stack>
          )}
        </Box>
      ) : null}
    </Box>
  );
}

function todoExecutionSummary(result: TodoExecutionResult): string {
  const runs = result.runs ?? [];
  const queued = runs.filter((run) => run.status === "queued").length;
  const waiting = runs.filter((run) => run.status === "waiting_approval").length;
  const other = runs.length - queued - waiting;
  const parts = [
    queued ? `${queued} queued` : null,
    waiting ? `${waiting} waiting approval` : null,
    other ? `${other} created` : null,
    result.skippedActive ? `${result.skippedActive} already active` : null,
    result.skippedCap ? `${result.skippedCap} deferred by cap` : null,
    result.failedRuns?.length ? `${result.failedRuns.length} failed` : null,
  ].filter(Boolean);
  ].filter(Boolean);

  if (parts.length === 0) {
    return `No To Dos queued (${result.eligibleIssues} eligible of ${result.totalOpenIssues} open).`;
  }
  return `${parts.join(" · ")} (${result.eligibleIssues} eligible of ${result.totalOpenIssues} open).`;
}
