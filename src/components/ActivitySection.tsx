/* AGPL-3.0-or-later */
import { Box, ScrollArea, Stack } from "@mantine/core";
import { RecentRunsCard } from "@/components/RecentRunsCard";
import { GoalsCard } from "@/components/GoalsCard";
import type { RecentRun } from "@/types";

// The monitor zone: the actionable run feed (approve/cancel/retry) plus goal
// history, in a single internally-scrolling column so it fills the available
// height without growing the page.
export function ActivitySection({ runs }: { runs: RecentRun[] }) {
  return (
    <Box style={{ flex: 1, minHeight: 0 }}>
      <ScrollArea h="100%" type="auto">
        <Stack gap="md" pr="sm">
          <RecentRunsCard runs={runs} />
          <GoalsCard />
        </Stack>
      </ScrollArea>
    </Box>
  );
}
