/* AGPL-3.0-or-later */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Loader,
  Menu,
  Modal,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconDots, IconEdit, IconTrash } from "@tabler/icons-react";
import { fetchJson } from "@/lib/api";
import { rowBorder, sectionHeader } from "@/lib/dashboard";
import type { Repo } from "@/types";

export function ReposCard({ repos }: { repos: Repo[] }) {
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: () =>
      fetchJson<{ synced: number; reason?: string }>("/api/integrations/github/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["overview"] }),
  });

  return (
    <Card withBorder radius="md" padding={0}>
      <Box px="lg" py="sm" style={sectionHeader}>
        <Group justify="space-between">
          <Title order={2} size="h4">
            GitHub Repos
          </Title>
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              {repos.length}
            </Text>
            <Button size="xs" variant="light" loading={sync.isPending} onClick={() => sync.mutate()}>
              Sync repos
            </Button>
          </Group>
        </Group>
        {sync.data ? (
          <Text size="xs" c={sync.data.reason ? "red" : "dimmed"} mt={4}>
            {sync.data.reason ?? `Synced ${sync.data.synced} repos`}
          </Text>
        ) : null}
        {sync.error ? (
          <Text size="xs" c="red" mt={4} role="alert">
            {(sync.error as Error).message}
          </Text>
        ) : null}
      </Box>
      <Stack gap={0}>
        {repos.map((repo) => (
          <RepoRow key={repo.id} repo={repo} />
        ))}
        {repos.length === 0 ? (
          <Box px="lg" py="xl">
            <Text c="dimmed" size="sm" mb="sm">
              No repos synced yet.
            </Text>
            <Button size="xs" variant="light" loading={sync.isPending} onClick={() => sync.mutate()}>
              Sync repos now
            </Button>
          </Box>
        ) : null}
      </Stack>
    </Card>
  );
}

function RepoRow({ repo }: { repo: Repo }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [newName, setNewName] = useState(repo.name);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const deleteRepo = useMutation({
    mutationFn: () =>
      fetchJson(`/api/repos/${repo.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      }),
    onSuccess: () => {
      setConfirmingDelete(false);
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  const renameRepo = useMutation({
    mutationFn: (name: string) =>
      fetchJson(`/api/repos/${repo.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  return (
    <>
      <Group justify="space-between" px="lg" py="sm" style={rowBorder} wrap="wrap">
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Anchor
            href={repo.url}
            target="_blank"
            rel="noopener noreferrer"
            size="sm"
            fw={600}
            truncate
            style={{ display: "block" }}
          >
            {repo.fullName}
          </Anchor>
          {repo.description ? (
            <Text size="xs" c="dimmed" truncate>
              {repo.description}
            </Text>
          ) : null}
        </Box>
        <Group gap="xs">
          <Group gap={4} wrap="nowrap">
            {repo.language ? (
              <Badge size="xs" variant="light" color="indigo" tt="none">
                {repo.language}
              </Badge>
            ) : null}
            {repo.private ? (
              <Badge size="xs" variant="outline" color="gray" tt="none">
                private
              </Badge>
            ) : null}
            {repo.archived ? (
              <Badge size="xs" variant="outline" color="orange" tt="none">
                archived
              </Badge>
            ) : null}
          </Group>
          <Text size="sm" c="dimmed" visibleFrom="sm">
            {repo.openIssues} open · ★ {repo.stars}
          </Text>
          <Menu shadow="md" width={200} position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`Actions for ${repo.fullName}`}>
                <IconDots style={{ width: 16, height: 16 }} />
              </ActionIcon>
            </Menu.Target>

            <Menu.Dropdown>
              <Menu.Label>Repository</Menu.Label>
              <Menu.Item
                leftSection={<IconEdit style={{ width: 14, height: 14 }} />}
                onClick={() => {
                  setNewName(repo.name);
                  setEditing(true);
                }}
              >
                Edit / Rename
              </Menu.Item>
              <Menu.Divider />
              <Menu.Label c="red">Danger zone</Menu.Label>
              <Menu.Item
                color="red"
                leftSection={<IconTrash style={{ width: 14, height: 14 }} />}
                onClick={() => {
                  setDeleteConfirmText("");
                  setConfirmingDelete(true);
                }}
              >
                Delete from GitHub
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>

      {deleteRepo.error || renameRepo.error ? (
        <Box px="lg" pb="sm">
          <Alert color="red" variant="light" title="GitHub operation failed">
            {deleteRepo.error?.message || renameRepo.error?.message}
          </Alert>
        </Box>
      ) : null}

      <Modal opened={editing} onClose={() => setEditing(false)} title="Rename repository" centered>
        <Stack gap="md">
          <TextInput
            label="New repository name"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            placeholder="e.g. my-awesome-app"
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="subtle" color="gray" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              loading={renameRepo.isPending}
              disabled={newName === repo.name || newName.length < 1}
              onClick={() => renameRepo.mutate(newName)}
            >
              Save changes
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title="Delete repository from GitHub"
        centered
      >
        <Stack gap="md">
          <Alert color="red" variant="light">
            This permanently deletes <strong>{repo.fullName}</strong> from GitHub. This cannot be undone.
          </Alert>
          <TextInput
            label={`Type "${repo.name}" to confirm`}
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.currentTarget.value)}
            placeholder={repo.name}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="subtle" color="gray" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button
              color="red"
              leftSection={deleteRepo.isPending ? <Loader size={14} color="white" /> : <IconTrash size={14} />}
              loading={deleteRepo.isPending}
              disabled={deleteConfirmText !== repo.name}
              onClick={() => deleteRepo.mutate()}
            >
              Delete permanently
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
