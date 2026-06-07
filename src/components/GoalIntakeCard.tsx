/* AGPL-3.0-or-later */
import { FormEvent, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Button, Card, Group, Select, Stack, Text, Textarea, Title } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { fetchJson } from "@/lib/api";
import type { Project, TaskResponse } from "@/types";

export function GoalIntakeCard({ projects }: { projects: Project[] }) {
  const queryClient = useQueryClient();
  const [objective, setObjective] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0];

  const taskMutation = useMutation({
    mutationFn: (payload: { objective: string; linearProjectId?: string }) =>
      fetchJson<TaskResponse>("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setObjective("");
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    taskMutation.mutate({
      objective,
      linearProjectId:
        selectedProject && selectedProject.id !== "linear_pending"
          ? selectedProject.id
          : undefined,
    });
  }

  return (
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" mb="md">
        <Title order={2} size="h4">
          Goal Intake
        </Title>
        <Badge color="teal" variant="light">
          approval gated
        </Badge>
      </Group>
      <form onSubmit={submitTask}>
        <Stack gap="sm">
          <Select
            label="Project"
            data={projects.map((project) => ({ value: project.id, label: project.name }))}
            value={selectedProject?.id ?? null}
            onChange={setSelectedProjectId}
            placeholder="Select a project"
            nothingFoundMessage="No projects"
          />
          <Textarea
            label="Objective"
            autosize
            minRows={4}
            value={objective}
            onChange={(event) => setObjective(event.currentTarget.value)}
            placeholder="Ship the next verified iteration for this Linear project"
          />
          <Group justify="space-between">
            <Text c="dimmed" size="sm">
              Manual approval required before sandbox execution
            </Text>
            <Button
              type="submit"
              loading={taskMutation.isPending}
              disabled={objective.trim().length < 4}
            >
              Queue task
            </Button>
          </Group>
        </Stack>
      </form>

      {taskMutation.isSuccess && taskMutation.data ? (
        <Alert color="teal" variant="light" mt="md" title="Task queued">
          <Stack gap="xs" align="flex-start">
            <Text size="sm">
              <Text span ff="monospace">{taskMutation.data.id}</Text>
              {" · "}
              {taskMutation.data.status}
              {taskMutation.data.approvalRequired
                ? " — waiting for your approval before it runs."
                : " — starting now."}
            </Text>
            {/* Approval-gated runs are approved in Recent Runs on this page and
                don't appear in the Command Center (which only shows active runs),
                so only link there once the run is actually starting. */}
            {taskMutation.data.approvalRequired ? (
              <Text size="xs" c="dimmed">
                Approve it in Recent Runs below to start execution.
              </Text>
            ) : (
              <Button component={Link} to="/command-center" size="xs" variant="light" color="teal">
                View in Command Center
              </Button>
            )}
          </Stack>
        </Alert>
      ) : null}

      {taskMutation.isError ? (
        <Alert color="red" variant="light" mt="md" title="Couldn't queue task">
          <Text size="sm">{(taskMutation.error as Error)?.message ?? "Request failed"}</Text>
        </Alert>
      ) : null}
    </Card>
  );
}
