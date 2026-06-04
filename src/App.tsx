/* AGPL-3.0-or-later */
import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Container,
  Group,
  Loader,
  Paper,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { fetchJson } from "@/lib/api";

type Provider = "github" | "linear";

type Overview = {
  user: {
    email: string | null;
    name: string | null;
    flyUserSlug: string;
    authSource: string;
  } | null;
  usage: {
    events: number;
    modelCalls: number;
    containerMinutes: number;
    deploys: number;
    browserCalls: number;
    firecrawlCalls: number;
    artifactWrites: number;
    costMicros: number;
  };
  connections: Array<{
    provider: Provider;
    status: string;
    accountName: string | null;
    updatedAt: string | null;
  }>;
  queue: {
    configured: boolean;
    pendingApproximation: number;
  };
  projects: Array<{
    id: string;
    name: string;
    status: string;
    url: string | null;
    repoMappingStatus: string;
    repoConfidence: number;
    repoUrl: string | null;
    suggestedRepo: string | null;
    activeRuns: number;
    failedRuns: number;
  }>;
  repos: Array<{
    id: string;
    owner: string;
    name: string;
    fullName: string;
    url: string;
    description: string | null;
    private: number;
    archived: number;
    openIssues: number;
    stars: number;
    language: string | null;
    pushedAt: string | null;
  }>;
  recentRuns: Array<{
    id: string;
    objective: string;
    status: string;
    projectName: string | null;
    autonomyMode: string;
    agentProvider: string;
    approvalRequired: number;
    createdAt: string;
    lastError: string | null;
  }>;
  recentArtifacts: Array<{
    id: string;
    kind: string;
    url: string | null;
    r2Key: string | null;
    createdAt: string;
  }>;
  templates: Array<{
    id: string;
    kind: string;
    repo: string;
    description: string;
    status: string;
  }>;
};

type TaskResponse = {
  id: string;
  status: string;
  approvalRequired: boolean;
};

type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  stateType: string;
  priority: number;
  assignee: string | null;
  updatedAt: string | null;
};

type ContinueResult = {
  summary: string;
  createdIssues: Array<{ id: string; identifier: string; url: string; title: string }>;
  queuedRuns: Array<{ id: string; issue: string }>;
  skipped: number;
};

const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: "github", label: "GitHub" },
  { id: "linear", label: "Linear" },
];

function getBannerFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("signin_required")) {
    const provider = params.get("provider");
    return provider ? `Sign in to connect ${provider}.` : "Sign in to continue.";
  }
  const oauthError = params.get("oauth_error");
  if (oauthError) {
    const provider = params.get("provider") ?? "the provider";
    return `OAuth with ${provider} failed: ${decodeURIComponent(oauthError)}. Try again.`;
  }
  const connected = params.get("connected");
  if (connected) {
    return `${connected} connected.`;
  }
  return null;
}

function startConnect(provider: Provider) {
  window.location.href = `/api/integrations/${provider}/connect`;
}

function SignInForm({ banner }: { banner: string | null }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const signIn = useMutation({
    mutationFn: () =>
      fetchJson<{ user: unknown }>("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
  return (
    <Container size={420} py={64}>
      <Title order={1} size="h2" mb={4}>
        dev.fly.pm
      </Title>
      <Text c="dimmed" size="sm" mb="lg">
        Sign in to continue.
      </Text>
      {banner ? (
        <Alert color="red" variant="light" mb="md">
          {banner}
        </Alert>
      ) : null}
      <Card withBorder padding="lg" radius="md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            signIn.mutate();
          }}
        >
          <Stack gap="sm">
            <TextInput
              label="Email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
            <PasswordInput
              label="Password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
            {signIn.error ? (
              <Text c="red" size="sm">
                {signIn.error.message}
              </Text>
            ) : null}
            <Button
              type="submit"
              loading={signIn.isPending}
              disabled={email.length === 0 || password.length === 0}
            >
              Sign in
            </Button>
          </Stack>
        </form>
      </Card>
    </Container>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [objective, setObjective] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const overviewQuery = useQuery({
    queryKey: ["overview"],
    queryFn: () => fetchJson<Overview>("/api/overview"),
  });

  const banner = getBannerFromUrl();

  // Login is via Cloudflare Access, so sign-out must clear the Access session,
  // not the unused better-auth one. Full-page navigate to /api/access-logout.
  function signOut() {
    window.location.href = "/api/access-logout";
  }

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

  // Pull the full list from a provider on demand (Linear projects / GitHub repos
  // otherwise only populate via webhooks or not at all). Refetches overview so
  // the synced items appear immediately. Keyed by provider so each Connections
  // row shows its own loading state.
  const [syncResult, setSyncResult] = useState<{ provider: Provider; synced: number; reason?: string } | null>(null);
  const sync = useMutation({
    mutationFn: (provider: Provider) =>
      fetchJson<{ synced: number; reason?: string }>(`/api/integrations/${provider}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    onSuccess: (data, provider) => {
      setSyncResult({ provider, synced: data.synced, reason: data.reason });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  // Auto-map all Linear projects to GitHub repos by name.
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

  // Early return AFTER all hooks have run so hook order is stable across
  // authed vs unauthed renders. See react.dev/errors/300.
  if (overviewQuery.data && !overviewQuery.data.user) {
    return <SignInForm banner={banner} />;
  }

  const overview = overviewQuery.data;
  const projects = overview?.projects ?? [];
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0];

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
    <Box mih="100vh" bg="var(--mantine-color-body)">
      <Box
        component="header"
        bg="var(--mantine-color-default)"
        style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
      >
        <Container size="xl" py="md">
          <Group justify="space-between" wrap="wrap">
            <Box>
              <Title order={1} size="h3">
                dev.fly.pm
              </Title>
              <Text c="dimmed" size="sm">
                {overview?.user
                  ? `${overview.user.flyUserSlug} · ${overview.user.authSource}`
                  : "Checking session"}
              </Text>
            </Box>
            <Group gap="xs">
              <Button variant="default" onClick={() => void overviewQuery.refetch()}>
                Refresh
              </Button>
              {overview?.user ? (
                <Button variant="default" onClick={signOut}>
                  Sign out
                </Button>
              ) : null}
            </Group>
          </Group>
        </Container>
      </Box>

      <Container size="xl" py="md">
        {banner ? (
          <Alert
            color={banner.includes("failed") ? "red" : "blue"}
            variant="light"
            mb="md"
          >
            {banner}
          </Alert>
        ) : null}

        <SimpleGrid cols={{ base: 1, xl: 2 }} spacing="lg">
          <Stack gap="lg">
            <SimpleGrid cols={{ base: 2, lg: 4 }} spacing="md">
              <Metric label="Usage events" value={overview?.usage.events ?? 0} />
              <Metric label="Model calls" value={overview?.usage.modelCalls ?? 0} />
              <Metric label="Container min" value={overview?.usage.containerMinutes ?? 0} />
              <Metric label="Deploys" value={overview?.usage.deploys ?? 0} />
            </SimpleGrid>

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
                    data={projects.map((project) => ({
                      value: project.id,
                      label: project.name,
                    }))}
                    value={selectedProject?.id ?? null}
                    onChange={setSelectedProjectId}
                    placeholder="Select a project"
                    nothingFoundMessage="No projects"
                  />
                  <Textarea
                    autosize
                    minRows={4}
                    value={objective}
                    onChange={(event) => setObjective(event.currentTarget.value)}
                    placeholder="Ship the next verified iteration for this Linear project"
                  />
                  <Group justify="space-between">
                    <Text c="dimmed" size="sm">
                      {taskMutation.data
                        ? `${taskMutation.data.id} · ${taskMutation.data.status}`
                        : taskMutation.error
                          ? taskMutation.error.message
                          : "Manual approval required before sandbox execution"}
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
            </Card>

            <Card withBorder radius="md" padding={0}>
              <Box px="lg" py="sm" style={sectionHeader}>
                <Group justify="space-between">
                  <Title order={2} size="h4">
                    Linear Projects
                  </Title>
                  <Button
                    size="xs"
                    variant="light"
                    loading={autoMap.isPending}
                    onClick={() => autoMap.mutate()}
                  >
                    Auto-map repos
                  </Button>
                </Group>
              </Box>
              <Stack gap={0}>
                {projects.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    repos={overview?.repos ?? []}
                  />
                ))}
                {projects.length === 0 ? <EmptyRow label="No projects" /> : null}
              </Stack>
            </Card>

            <Card withBorder radius="md" padding={0}>
              <Box px="lg" py="sm" style={sectionHeader}>
                <Group justify="space-between">
                  <Title order={2} size="h4">
                    GitHub Repos
                  </Title>
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">
                      {(overview?.repos ?? []).length}
                    </Text>
                    <Button
                      size="xs"
                      variant="light"
                      loading={sync.isPending && sync.variables === "github"}
                      onClick={() => sync.mutate("github")}
                    >
                      Sync repos
                    </Button>
                  </Group>
                </Group>
                {sync.data && sync.variables === "github" ? (
                  <Text size="xs" c={sync.data.reason ? "red" : "dimmed"} mt={4}>
                    {sync.data.reason ?? `Synced ${sync.data.synced} repos`}
                  </Text>
                ) : null}
                {sync.error && sync.variables === "github" ? (
                  <Text size="xs" c="red" mt={4}>
                    {(sync.error as Error).message}
                  </Text>
                ) : null}
              </Box>
              <Stack gap={0}>
                {(overview?.repos ?? []).map((repo) => (
                  <RepoRow key={repo.id} repo={repo} />
                ))}
                {(overview?.repos ?? []).length === 0 ? (
                  <Box px="lg" py="xl">
                    <Text c="dimmed" size="sm" mb="sm">
                      No repos synced yet.
                    </Text>
                    <Button
                      size="xs"
                      variant="light"
                      loading={sync.isPending && sync.variables === "github"}
                      onClick={() => sync.mutate("github")}
                    >
                      Sync repos now
                    </Button>
                  </Box>
                ) : null}
              </Stack>
            </Card>

            <Card withBorder radius="md" padding={0}>
              <Box px="lg" py="sm" style={sectionHeader}>
                <Title order={2} size="h4">
                  Recent Runs
                </Title>
              </Box>
              <Stack gap={0}>
                {(overview?.recentRuns ?? []).length > 0 ? (
                  overview!.recentRuns.map((run) => <RunRow key={run.id} run={run} />)
                ) : (
                  <EmptyRow label="No runs queued" />
                )}
              </Stack>
            </Card>
          </Stack>

          <Stack gap="lg">
            <Card withBorder radius="md" padding={0}>
              <Box px="lg" py="sm" style={sectionHeader}>
                <Group justify="space-between">
                  <Title order={2} size="h4">
                    Connections
                  </Title>
                  {syncResult ? (
                    <Text size="xs" c={syncResult.reason ? "orange" : "teal"}>
                      {syncResult.provider}: {syncResult.synced} synced
                      {syncResult.reason ? ` · ${syncResult.reason}` : ""}
                    </Text>
                  ) : null}
                </Group>
              </Box>
              <Stack gap={0}>
                {PROVIDERS.map((provider) => {
                  const connection = overview?.connections.find(
                    (item) => item.provider === provider.id,
                  );
                  const connected = connection?.status === "connected";
                  return (
                    <Group
                      key={provider.id}
                      justify="space-between"
                      px="lg"
                      py="sm"
                      style={rowBorder}
                    >
                      <Box>
                        <Text size="sm" fw={600}>
                          {provider.label}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {connection?.accountName ?? "not connected"}
                        </Text>
                      </Box>
                      {connected ? (
                        <Group gap="xs">
                          <StatusBadge status={connection!.status} />
                          <Button
                            size="xs"
                            variant="subtle"
                            loading={sync.isPending && sync.variables === provider.id}
                            onClick={() => sync.mutate(provider.id)}
                          >
                            Sync
                          </Button>
                        </Group>
                      ) : (
                        <Button
                          size="xs"
                          variant="light"
                          onClick={() => startConnect(provider.id)}
                        >
                          Connect {provider.label}
                        </Button>
                      )}
                    </Group>
                  );
                })}
              </Stack>
            </Card>

            <Card withBorder radius="md" padding="lg">
              <Title order={2} size="h4" mb="md">
                Queue
              </Title>
              <SimpleGrid cols={2} spacing="md">
                <Metric label="Configured" value={overview?.queue.configured ? "yes" : "no"} />
                <Metric label="Pending" value={overview?.queue.pendingApproximation ?? 0} />
              </SimpleGrid>
            </Card>

            <Card withBorder radius="md" padding={0}>
              <Box px="lg" py="sm" style={sectionHeader}>
                <Title order={2} size="h4">
                  Templates
                </Title>
              </Box>
              <Stack gap={0}>
                {(overview?.templates ?? []).map((template) => (
                  <Box key={template.id} px="lg" py="sm" style={rowBorder}>
                    <Group justify="space-between">
                      <Text size="sm" fw={600}>
                        {template.kind}
                      </Text>
                      <StatusBadge status={template.status} />
                    </Group>
                    <Anchor
                      href={`https://github.com/${template.repo}`}
                      size="xs"
                      mt={4}
                      style={{ wordBreak: "break-all" }}
                    >
                      {template.repo}
                    </Anchor>
                  </Box>
                ))}
                {(overview?.templates ?? []).length === 0 ? (
                  <EmptyRow label="No templates" />
                ) : null}
              </Stack>
            </Card>

            <Card withBorder radius="md" padding={0}>
              <Box px="lg" py="sm" style={sectionHeader}>
                <Title order={2} size="h4">
                  Artifacts
                </Title>
              </Box>
              <Stack gap={0}>
                {(overview?.recentArtifacts ?? []).length > 0 ? (
                  overview!.recentArtifacts.map((artifact) => (
                    <Box key={artifact.id} px="lg" py="sm" style={rowBorder}>
                      <Text size="sm" fw={600}>
                        {artifact.kind}
                      </Text>
                      <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
                        {artifact.url ?? artifact.r2Key}
                      </Text>
                    </Box>
                  ))
                ) : (
                  <EmptyRow label="No artifacts written" />
                )}
              </Stack>
            </Card>
          </Stack>
        </SimpleGrid>
      </Container>
    </Box>
  );
}

const sectionHeader: React.CSSProperties = {
  borderBottom: "1px solid var(--mantine-color-default-border)",
};

const rowBorder: React.CSSProperties = {
  borderTop: "1px solid var(--mantine-color-default-border)",
};

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <Paper withBorder radius="md" p="md">
      <Text size="xs" fw={600} tt="uppercase" c="dimmed">
        {label}
      </Text>
      <Text size="xl" fw={700} mt={4}>
        {value}
      </Text>
    </Paper>
  );
}

const PRIORITY_LABELS: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

function ProjectRow({
  project,
  repos,
}: {
  project: Overview["projects"][number];
  repos: Overview["repos"];
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  // Open issues are fetched live (never stored) and only when the row is
  // expanded, so collapsed projects cost nothing.
  const issuesQuery = useQuery({
    queryKey: ["issues", project.id],
    queryFn: () =>
      fetchJson<{ issues: LinearIssue[]; reason?: string }>(
        `/api/projects/${project.id}/issues`,
      ),
    enabled: expanded,
  });

  const issues = issuesQuery.data?.issues ?? [];

  // Manual repo mapping: pick a synced repo (or clear). The current mapping is
  // matched back to a repo id via its URL so the Select shows the active value.
  const currentRepoId =
    repos.find((repo) => repo.url === project.repoUrl)?.id ?? null;
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
  const continueMutation = useMutation({
    mutationFn: () =>
      fetchJson<ContinueResult>(`/api/projects/${project.id}/continue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["issues", project.id] });
    },
  });

  return (
    <Box style={rowBorder}>
      <Group
        justify="space-between"
        px="lg"
        py="sm"
        wrap="wrap"
        onClick={() => setExpanded((value) => !value)}
        style={{ cursor: "pointer" }}
      >
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Group gap="xs" wrap="nowrap">
            <Text size="xs" c="dimmed" w={10}>
              {expanded ? "▾" : "▸"}
            </Text>
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

      {expanded ? (
        <Box px="lg" pb="sm" pl={32}>
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
                  const suggested = repos.find(
                    (repo) => repo.fullName === project.suggestedRepo,
                  );
                  if (suggested) setMapping.mutate(suggested.id);
                }}
              >
                Use {project.suggestedRepo}
              </Button>
            ) : null}
          </Group>

          <Group gap="xs" align="center" pb="xs" wrap="wrap">
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
          </Group>

          {continueMutation.error ? (
            <Text size="xs" c="red" pb="xs">
              {(continueMutation.error as Error).message}
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
                <Anchor key={iss.id} href={iss.url} target="_blank" size="xs" truncate>
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
            <Text size="xs" c="red" py="xs">
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

function RepoRow({ repo }: { repo: Overview["repos"][number] }) {
  return (
    <Group justify="space-between" px="lg" py="sm" style={rowBorder} wrap="wrap">
      <Box style={{ minWidth: 0, flex: 1 }}>
        <Anchor href={repo.url} target="_blank" size="sm" fw={600} truncate style={{ display: "block" }}>
          {repo.fullName}
        </Anchor>
        {repo.description ? (
          <Text size="xs" c="dimmed" truncate>
            {repo.description}
          </Text>
        ) : null}
      </Box>
      <Group gap="xs">
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
      <Text size="sm" c="dimmed">
        {repo.openIssues} open · ★ {repo.stars}
      </Text>
    </Group>
  );
}

function RunRow({ run }: { run: Overview["recentRuns"][number] }) {
  const queryClient = useQueryClient();
  const approve = useMutation({
    mutationFn: () =>
      fetchJson(`/api/runs/${run.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["overview"] }),
  });
  const cancel = useMutation({
    mutationFn: () =>
      fetchJson(`/api/runs/${run.id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["overview"] }),
  });
  const waiting = run.status === "waiting_approval";
  return (
    <Group justify="space-between" px="lg" py="sm" style={rowBorder} wrap="wrap">
      <Box style={{ minWidth: 0, flex: 1 }}>
        <Text size="sm" fw={600} truncate>
          {run.objective}
        </Text>
        <Text size="xs" c="dimmed" truncate>
          {run.projectName ?? run.id}
        </Text>
      </Box>
      <Group gap="xs">
        <StatusBadge status={run.status} />
        <StatusBadge status={run.agentProvider} />
      </Group>
      {waiting ? (
        <Group gap="xs">
          <Button size="xs" color="teal" loading={approve.isPending} onClick={() => approve.mutate()}>
            Approve
          </Button>
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            loading={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Cancel
          </Button>
        </Group>
      ) : (
        <Text size="sm" c="dimmed">
          {run.approvalRequired ? "approval" : "queued"}
        </Text>
      )}
    </Group>
  );
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.replaceAll("_", " ");
  const color =
    status.includes("failed") || status.includes("error")
      ? "red"
      : status === "connected" || status === "active" || status === "mapped"
        ? "teal"
        : "indigo";
  return (
    <Badge color={color} variant="light" tt="none">
      {normalized}
    </Badge>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <Box px="lg" py="xl">
      <Text c="dimmed" size="sm">
        {label}
      </Text>
    </Box>
  );
}
