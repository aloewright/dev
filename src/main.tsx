/* AGPL-3.0-or-later */
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ColorSchemeScript, MantineProvider } from "@mantine/core";
import { router } from "@/router";
import { theme } from "@/theme";
import { ErrorBoundary } from "@/ErrorBoundary";

// Nunito weights used across the UI.
import "@fontsource/nunito/400.css";
import "@fontsource/nunito/600.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";

// Mantine styles are imported (in a cascade layer) from styles.css so they sit
// in the correct order relative to Tailwind.
import "@/styles.css";
import "@mantine/spotlight/styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ColorSchemeScript defaultColorScheme="dark" />
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <RouterProvider router={router} />
        </ErrorBoundary>
      </QueryClientProvider>
    </MantineProvider>
  </React.StrictMode>,
);
