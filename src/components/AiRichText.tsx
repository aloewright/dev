/* AGPL-3.0-or-later */
import { useEffect, useRef, useState } from "react";
import { Box, Button, Group, Modal, Stack, Text, Textarea } from "@mantine/core";
import { filterSuggestionItems } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import {
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { fetchJson } from "@/lib/api";

// Markdown-backed rich text editor with a `/ai` slash command that generates text
// via the worker's AI Gateway endpoint. Value in/out is Markdown so it stays a
// plain string that's safe to inject into prompts.
export function AiRichText({
  value,
  onChange,
  minHeight = 180,
}: {
  value: string;
  onChange: (markdown: string) => void;
  minHeight?: number;
}) {
  const editor = useCreateBlockNote();
  const seeded = useRef(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Seed the editor from the initial markdown exactly once.
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    let cancelled = false;
    void (async () => {
      if (!value) return;
      const blocks = await editor.tryParseMarkdownToBlocks(value);
      if (!cancelled && blocks.length) editor.replaceBlocks(editor.document, blocks);
    })();
    return () => {
      cancelled = true;
    };
  }, [editor, value]);

  async function emitChange() {
    onChange(await editor.blocksToMarkdownLossy(editor.document));
  }

  async function runAi() {
    setBusy(true);
    setErr(null);
    try {
      const context = await editor.blocksToMarkdownLossy(editor.document);
      const { text } = await fetchJson<{ text: string }>("/api/ai/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: instruction, context }),
      });
      const blocks = await editor.tryParseMarkdownToBlocks(text);
      const ref = editor.getTextCursorPosition().block ?? editor.document[editor.document.length - 1];
      if (ref) editor.insertBlocks(blocks, ref, "after");
      else editor.replaceBlocks(editor.document, blocks);
      await emitChange();
      setAiOpen(false);
      setInstruction("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  }

  const aiItem: DefaultReactSuggestionItem = {
    title: "AI: generate…",
    subtext: "Generate text with AI",
    aliases: ["ai", "generate", "write"],
    group: "AI",
    onItemClick: () => setAiOpen(true),
  };

  return (
    <>
      <Box
        style={{
          border: "1px solid var(--mantine-color-default-border)",
          borderRadius: "var(--mantine-radius-sm)",
          minHeight,
          padding: 4,
        }}
      >
        <BlockNoteView editor={editor} theme="dark" onChange={() => void emitChange()} slashMenu={false}>
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) =>
              filterSuggestionItems([...getDefaultReactSlashMenuItems(editor), aiItem], query)
            }
          />
        </BlockNoteView>
      </Box>

      <Modal opened={aiOpen} onClose={() => setAiOpen(false)} title="Generate with AI" centered>
        <Stack gap="sm">
          <Textarea
            data-autofocus
            autosize
            minRows={3}
            value={instruction}
            onChange={(e) => setInstruction(e.currentTarget.value)}
            placeholder="e.g. Draft guardrails for a cautious coding agent that never touches production"
          />
          {err ? <Text c="red" size="xs">{err}</Text> : null}
          <Group justify="flex-end">
            <Button variant="subtle" color="gray" onClick={() => setAiOpen(false)}>Cancel</Button>
            <Button loading={busy} disabled={!instruction.trim()} onClick={() => void runAi()}>Generate</Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
