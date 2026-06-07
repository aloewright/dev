/* AGPL-3.0-or-later */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Box, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { fetchJson } from "@/lib/api";
import { PROVIDERS, sectionHeader, rowBorder, startConnect } from "@/lib/dashboard";
import { StatusBadge } from "@/components/primitives";
import type { Overview, Provider } from "@/types";

export function ConnectionsCard({ connections }: { connections: Overview["connections"] }) {
  const queryClient = useQueryClient();
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

  return (
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
          const connection = connections.find((item) => item.provider === provider.id);
          const connected = connection?.status === "connected";
          return (
            <Group key={provider.id} justify="space-between" px="lg" py="sm" style={rowBorder}>
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
                  <Button size="xs" variant="light" onClick={() => startConnect(provider.id)}>
                    Reconnect
                  </Button>
                </Group>
              ) : (
                <Button size="xs" variant="light" onClick={() => startConnect(provider.id)}>
                  Connect {provider.label}
                </Button>
              )}
            </Group>
          );
        })}
      </Stack>
    </Card>
  );
}
