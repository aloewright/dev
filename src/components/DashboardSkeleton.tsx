/* AGPL-3.0-or-later */
import { SimpleGrid, Skeleton, Stack } from "@mantine/core";

export function DashboardSkeleton() {
  return (
    <SimpleGrid cols={{ base: 1, xl: 2 }} spacing="lg">
      <Stack gap="lg">
        <SimpleGrid cols={{ base: 2, lg: 4 }} spacing="md">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} height={72} radius="md" />
          ))}
        </SimpleGrid>
        <Skeleton height={220} radius="md" />
        <Skeleton height={260} radius="md" />
      </Stack>
      <Stack gap="lg">
        <Skeleton height={180} radius="md" />
        <Skeleton height={200} radius="md" />
        <Skeleton height={160} radius="md" />
      </Stack>
    </SimpleGrid>
  );
}
