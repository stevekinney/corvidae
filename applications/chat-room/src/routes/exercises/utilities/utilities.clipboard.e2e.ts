import { expect, test } from '@playwright/test';
import { gotoHydrated } from '../hydration';

function defined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} was not produced.`);
  return value;
}

// Mirrors `buildSeededConversation()` in +page.svelte: 4 seed messages
// (user, assistant, tool-call, tool-result) followed by 20 padding messages
// alternating user/assistant starting with user. Kept in one place so both
// the Markdown and JSON export assertions below check against the same
// ground truth as the page's own message rows.

type ExportedMessage = {
  id: string;
  role: string;
  content: unknown;
  toolCall?: { id: string; name: string; arguments: unknown };
  toolResult?: { callId: string; outcome: string; content: unknown };
};

type ExportedConversation = {
  schemaVersion: string;
  exportedAt: string;
  conversationId: string;
  messages: ExportedMessage[];
};

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalToolCall(value: unknown): ExportedMessage['toolCall'] {
  if (value === undefined) return undefined;
  const record = objectRecord(value, 'tool call');
  const id = record['id'];
  const name = record['name'];
  if (typeof id !== 'string' || typeof name !== 'string') {
    throw new Error('Expected tool call id and name to be strings.');
  }
  return { id, name, arguments: record['arguments'] };
}

function optionalToolResult(value: unknown): ExportedMessage['toolResult'] {
  if (value === undefined) return undefined;
  const record = objectRecord(value, 'tool result');
  const callId = record['callId'];
  const outcome = record['outcome'];
  if (typeof callId !== 'string' || typeof outcome !== 'string') {
    throw new Error('Expected tool result callId and outcome to be strings.');
  }
  return { callId, outcome, content: record['content'] };
}

function exportedConversation(value: unknown): ExportedConversation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected exported conversation to be an object.');
  }
  const schemaVersion = Reflect.get(value, 'schemaVersion');
  const exportedAt = Reflect.get(value, 'exportedAt');
  const conversationId = Reflect.get(value, 'conversationId');
  const messages = Reflect.get(value, 'messages');
  if (
    typeof schemaVersion !== 'string' ||
    typeof exportedAt !== 'string' ||
    typeof conversationId !== 'string'
  ) {
    throw new Error('Expected exported conversation metadata to be strings.');
  }
  if (!Array.isArray(messages)) throw new Error('Expected exported messages to be an array.');
  return {
    schemaVersion,
    exportedAt,
    conversationId,
    messages: messages.map((message) => {
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        throw new Error('Expected exported message to be an object.');
      }
      const id = Reflect.get(message, 'id');
      const role = Reflect.get(message, 'role');
      if (typeof id !== 'string' || typeof role !== 'string') {
        throw new Error('Expected exported message id and role to be strings.');
      }
      const toolCall = optionalToolCall(Reflect.get(message, 'toolCall'));
      const toolResult = optionalToolResult(Reflect.get(message, 'toolResult'));
      return {
        id,
        role,
        content: Reflect.get(message, 'content'),
        ...(toolCall === undefined ? {} : { toolCall }),
        ...(toolResult === undefined ? {} : { toolResult }),
      };
    }),
  };
}

const EXPECTED_ROLES = [
  'user',
  'assistant',
  'tool-call',
  'tool-result',
  ...Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? 'user' : 'assistant')),
];

test('ConversationExportActions: Markdown export matches the full expected structure', async ({
  context,
  page,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gotoHydrated(page, '/exercises/utilities');

  const status = page.getByTestId('utilities-export-status');
  await expect(status).toHaveText('');

  await page.getByRole('button', { name: 'Export conversation' }).click();
  await page.getByRole('menuitem', { name: /Copy as Markdown/ }).click();
  await expect(status).toHaveText('exported: markdown');

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());

  // messagesToMarkdown joins `**RoleLabel:**\n\n<text>` blocks with
  // `\n\n---\n\n` (utilities.ts in @repo/chat) — one block per
  // message, in transcript order, with no role-based filtering here (no
  // system/developer messages in this seeded conversation).
  const blocks = clipboardText.split('\n\n---\n\n');
  expect(blocks).toHaveLength(EXPECTED_ROLES.length);

  const roleLabels: Record<string, string> = {
    user: 'You',
    assistant: 'Assistant',
    'tool-call': 'Tool Call',
    'tool-result': 'Tool Result',
  };
  for (const [index, role] of EXPECTED_ROLES.entries()) {
    expect(
      defined(blocks[index], `markdown block ${index}`).startsWith(`**${roleLabels[role]}:**\n\n`),
    ).toBe(true);
  }

  // Text-bearing messages carry their real content...
  expect(defined(blocks[0], 'first markdown block')).toBe(
    '**You:**\n\nWhat is the weather in **Portland**?',
  );
  expect(defined(blocks[1], 'second markdown block')).toContain('Let me check that for you.');
  expect(defined(blocks[4], 'first padding markdown block')).toBe(
    '**You:**\n\nPadding message 1 — enough text to give this row real height so the transcript overflows the viewport.',
  );
  expect(defined(blocks[23], 'last padding markdown block')).toBe(
    '**Assistant:**\n\nPadding message 20 — enough text to give this row real height so the transcript overflows the viewport.',
  );

  // ...while the tool-call/tool-result pair carries its payload in
  // `toolCall`/`toolResult`, not `content` — formatMessageAsMarkdown is
  // text-only, so their bodies are empty (see the utility-function
  // assertions above for the same contract).
  expect(blocks[2]).toBe('**Tool Call:**\n\n');
  expect(blocks[3]).toBe('**Tool Result:**\n\n');
});

test('ConversationExportActions: JSON export round-trips the full conversation', async ({
  context,
  page,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gotoHydrated(page, '/exercises/utilities');

  const status = page.getByTestId('utilities-export-status');
  await expect(status).toHaveText('');

  // Cross-check the exported ids against what the page actually rendered
  // for the same messages, so "ids survive round-trip" is checked against
  // real DOM state, not just re-asserted against the test's own fixture.
  const rows = page.getByTestId('utilities-message-row');
  const firstRowId = await rows.first().getAttribute('data-message-id');
  const secondRowId = await rows.nth(1).getAttribute('data-message-id');

  await page.getByRole('button', { name: 'Export conversation' }).click();
  await page.getByRole('menuitem', { name: /Copy as JSON/ }).click();
  await expect(status).toHaveText('exported: json');

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  const exported = exportedConversation(JSON.parse(clipboardText));

  expect(exported.schemaVersion).toBe('1.0');
  expect(new Date(exported.exportedAt).toString()).not.toBe('Invalid Date');
  expect(exported.conversationId).toBe('utilities-demo');

  // Message count and the full role sequence match the seeded conversation.
  expect(exported.messages).toHaveLength(EXPECTED_ROLES.length);
  expect(exported.messages.map((message) => message.role)).toEqual(EXPECTED_ROLES);

  // ids and content survive the round-trip, including against the page's
  // own rendered ids for the same two messages.
  const firstMessage = defined(exported.messages[0], 'first exported message');
  const secondMessage = defined(exported.messages[1], 'second exported message');
  const toolCallMessage = defined(exported.messages[2], 'tool call message');
  const toolResultMessage = defined(exported.messages[3], 'tool result message');
  expect(firstMessage.id).toBe(firstRowId);
  expect(firstMessage.content).toBe('What is the weather in **Portland**?');
  expect(secondMessage.id).toBe(secondRowId);
  expect(secondMessage.content).toContain('Let me check that for you.');

  // The tool-call/tool-result pair is represented via `toolCall`/`toolResult`.
  expect(toolCallMessage.toolCall).toEqual({
    id: 'call-1',
    name: 'get_weather',
    arguments: { city: 'Portland' },
  });
  expect(toolResultMessage.toolResult).toEqual({
    callId: 'call-1',
    outcome: 'success',
    content: { tempF: 54, sky: 'overcast' },
  });
});
