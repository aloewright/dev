/* AGPL-3.0-or-later */
import { FormEvent, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Anchor, Badge, Button, Card, Group, Select, Stack, Text, Textarea, Title } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { fetchJson } from "@/lib/api";
import type { Project } from "@/types";

type GoalResult = {
  goalId: string;
  summary: string;
  createdIssues: Array<{ id: string; identifier: string; url: string; title: string }>;
  queuedRuns: Array<{ id: string; issue: string }>;
  skipped: number;
};

export function GoalIntakeCard({ projects }: { projects: Project[] }) {
  const queryClient = useQueryClient();
  const [objective, setObjective] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  // A goal can only execute against a project that has a GitHub repo mapped — that
  // mapping is what every decomposed run clones. Without it the runs have nothing
  // to act on (the old failure mode).
  const repoMapped = Boolean(selectedProject?.repoUrl);

  const goalMutation = useMutation({
    mutationFn: (payload: { objective: string; linearProjectId: string }) =>
      fetchJson<GoalResult>("/api/goals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setObjective("");
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["goals"] });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProject) return;
    goalMutation.mutate({ objective, linearProjectId: selectedProject.id });
  }

  const result = goalMutation.data;

  return (
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" mb="md">
        <Title order={2} size="h4">
          Goal Intake
        </Title>
        <Badge color="teal" variant="light">
          breaks into issues → VMs
        </Badge>
      </Group>
      <form onSubmit={submit}>
        <Stack gap="sm">
          <Select
            label="Project"
            description="The goal's issues and runs target this project's mapped repo."
            data={projects.map((project) => ({
              value: project.id,
              label: project.repoUrl ? project.name : `${project.name} (no repo mapped)`,
            }))}
            value={selectedProject?.id ?? null}
            onChange={setSelectedProjectId}
            placeholder="Select a project"
            nothingFoundMessage="No projects — sync Linear first"
          />
          {selectedProject ? (
            <Text size="xs" c={repoMapped ? "dimmed" : "orange"}>
              {repoMapped
                ? `Target repo: ${selectedProject.repoUrl}`
                : "This project has no GitHub repo mapped. Map one in Linear Projects below before running a goal."}
            </Text>
          ) : null}
          <Textarea
            label="Goal"
            description="Describe the outcome. It'll be decomposed into Linear issues, one VM run each."
            autosize
            minRows={4}
            value={objective}
            onChange={(event) => setObjective(event.currentTarget.value)}
            placeholder="e.g. Add SSO login with Google and GitHub, including tests and docs"
          />
          <Group justify="space-between">
            <Text c="dimmed" size="sm">
              Runs execute autonomously on Claude Code (Gemma failover on usage limit)
            </Text>
            <Button
              type="submit"
              loading={goalMutation.isPending}
              disabled={objective.trim().length < 4 || !selectedProject || !repoMapped}
            >
              Plan & run goal
            </Button>
          </Group>
        </Stack>
      </form>

      {goalMutation.isPending ? (
        <Text size="sm" c="dimmed" mt="md">
          Breaking the goal into issues and dispatching runs…
        </Text>
      ) : null}

      {result ? (
        <Alert color="teal" variant="light" mt="md" title="Goal dispatched">
          <Stack gap="xs" align="flex-start">
            {result.summary ? <Text size="sm">{result.summary}</Text> : null}
            <Text size="sm" fw={600}>
              {result.createdIssues.length} issue(s) created · {result.queuedRuns.length} run(s) started
              {result.skipped > 0 ? ` · ${result.skipped} queued behind the run cap` : ""}
            </Text>
            <Stack gap={2}>
              {result.createdIssues.map((issue) => (
                <Anchor key={issue.id} href={issue.url} target="_blank" rel="noopener noreferrer" size="xs">
                  <Text component="span" size="xs" c="dimmed" mr={6}>
                    {issue.identifier}
                  </Text>
                  {issue.title}
                </Anchor>
              ))}
            </Stack>
            {result.queuedRuns.length > 0 ? (
              <Button component={Link} to="/command-center" size="xs" variant="light" color="teal">
                Watch runs in Command Center
              </Button>
            ) : null}
          </Stack>
        </Alert>
      ) : null}

      {goalMutation.isError ? (
        <Alert color="red" variant="light" mt="md" title="Couldn't run this goal">
          <Text size="sm">{(goalMutation.error as Error)?.message ?? "Request failed"}</Text>
        </Alert>
      ) : null}
    </Card>
  );
}
