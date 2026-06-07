/* AGPL-3.0-or-later */
import { Component, ReactNode } from "react";
import { Alert, Box, Button, Code, Container, Stack, Text, Title } from "@mantine/core";

interface Props { children: ReactNode }
interface State { error: Error | null }

// Catches render-time crashes anywhere below the router so a single bad component
// shows a recoverable error card instead of a white screen.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Box mih="100vh" bg="var(--mantine-color-body)">
        <Container size="sm" py="xl">
          <Stack gap="md">
            <Title order={1} size="h3">Something broke</Title>
            <Alert color="red" variant="light" title="The portal hit an unexpected error">
              <Stack gap="sm">
                <Text size="sm">
                  This is a bug in the dashboard, not your account. Reloading usually clears it.
                </Text>
                <Code block>{this.state.error.message}</Code>
              </Stack>
            </Alert>
            <Button onClick={() => window.location.reload()} w="fit-content">
              Reload portal
            </Button>
          </Stack>
        </Container>
      </Box>
    );
  }
}
