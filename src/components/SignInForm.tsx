/* AGPL-3.0-or-later */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Container, PasswordInput, Stack, Text, TextInput, Title } from "@mantine/core";
import { fetchJson } from "@/lib/api";

export function SignInForm({ banner }: { banner: string | null }) {
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
              <Text c="red" size="sm" role="alert">
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
