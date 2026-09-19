<script lang="ts">
  import {
    appendAssistantMessage,
    appendUserMessage,
    Conversation,
    conversationFromMarkdown,
    conversationToMarkdown,
    createConversationHistory,
    fromMarkdown,
    getRoleLabel,
    toMarkdown,
  } from '@corvidae/conversationalist';

  const environment = {
    now: () => '2026-01-01T00:00:00.000Z',
    randomId: (() => {
      let sequence = 0;
      return () => `fixture-id-${++sequence}`;
    })(),
  };
  let history = createConversationHistory(
    {
      id: 'conversation-fixture',
      title: 'Release review',
      metadata: { project: 'corvidae', priority: 'high' },
    },
    environment,
  );
  history = appendUserMessage(
    history,
    'Please review the release notes.',
    { turn: 1 },
    environment,
  );
  history = appendAssistantMessage(
    history,
    'The release notes are ready for approval.',
    { turn: 2, reviewed: true },
    environment,
  );

  const markdown = toMarkdown(history, { includeMetadata: true });
  const parsedHistory = fromMarkdown(markdown);
  const controller = new Conversation(history, environment);
  const controllerMarkdown = conversationToMarkdown(controller, { includeMetadata: true });
  const restoredController = conversationFromMarkdown(controllerMarkdown);
</script>

<main data-testid="conversation-markdown-proof">
  <h1>{history.title}</h1>
  <p data-testid="role-labels">{getRoleLabel('user')} → {getRoleLabel('assistant')}</p>
  <p data-testid="message-order">{history.ids.join('|')}</p>
  <p data-testid="parsed-message-order">{parsedHistory.ids.join('|')}</p>
  <p data-testid="controller-message-order">{restoredController.current.ids.join('|')}</p>
  <p data-testid="conversation-metadata">{String(parsedHistory.metadata['project'])}</p>
  <p data-testid="message-metadata">
    {String(parsedHistory.messages[history.ids[0] ?? '']?.metadata['turn'])} →
    {String(parsedHistory.messages[history.ids[1] ?? '']?.metadata['reviewed'])}
  </p>
  <pre data-testid="markdown-output">{markdown}</pre>
</main>

<style>
  main {
    max-inline-size: 52rem;
    margin-inline: auto;
  }
  pre {
    white-space: pre-wrap;
    border: 1px solid var(--cinder-border-subtle);
    padding: 1rem;
  }
</style>
