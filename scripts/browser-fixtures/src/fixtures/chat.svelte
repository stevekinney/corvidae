<script lang="ts">
  import {
    ArtifactViewer,
    Chat,
    ChatArtifactLayout,
    ChatConversationHeader,
    ChatConversationList,
    appendAssistantMessage,
    appendMessages,
    appendUserMessage,
    createConversation,
    deriveConversationSummary,
    type ChatRowContext,
    type ChatSubmitEvent,
    type ChatAdapter,
    type ResolvedChatArtifact,
  } from '@corvidae/chat';
  import { Button } from '@corvidae/cinder';
  import type { ApprovalResolution } from '@corvidae/cinder';

  const adapter: ChatAdapter = {
    sendMessage: async () => {},
    describeToolCall: (_toolCall, result) => ({
      verb: result?.outcome === 'success' ? 'Checked' : 'Checking',
      tense: result?.outcome === 'success' ? 'past' : 'present',
      detail: 'the package exports',
      kind: 'search',
    }),
  };

  let basicConversation = $state.raw(
    appendAssistantMessage(
      appendUserMessage(createConversation({ id: 'basic-chat' }), 'Can you summarize this plan?'),
      'The plan is ready to implement.',
    ),
  );

  let approvalConversation = appendMessages(
    appendUserMessage(
      createConversation({ id: 'tool-approval-chat' }),
      'Deploy the latest build to production.',
    ),
    {
      role: 'tool-call',
      content: '',
      toolCall: {
        id: 'call-deploy-prod',
        name: 'deploy_to_production',
        arguments: { environment: 'production', version: '2.4.1' },
      },
    },
    {
      role: 'tool-result',
      content: '',
      toolResult: {
        callId: 'call-deploy-prod',
        outcome: 'action_required',
        content: null,
        action: {
          type: 'approval',
          message: 'Approve running this tool before it executes?',
          risk: 'high',
          operation: {
            kind: 'command',
            command: 'deploy_to_production --environment production --version 2.4.1',
            filesTouched: ['applications/chat-room/deployments/production.json'],
            argsPreview: { environment: 'production', version: '2.4.1', replicas: 3 },
          },
          sandbox: {
            provider: 'Corvidae',
            name: 'production-release',
            workingDir: '/workspace/corvidae',
          },
          env: ['DEPLOY_TOKEN', 'RELEASE_CHANNEL'],
          snapshotId: 'snapshot-deploy-prod',
          expiresAt: '2999-01-01T00:00:00.000Z',
          editableArgs: true,
          policyVersion: 'approval-fixture-policy-v1',
          idempotencyKey: 'fixture-call-deploy-prod',
        },
      },
    },
  );

  const longArtifactTitle =
    'Exports report with a long generated title that should truncate visually while retaining the full accessible name';

  let pairedConversation = appendMessages(
    appendUserMessage(
      createConversation({ id: 'tool-call-chat' }),
      'Check whether the package has drift.',
    ),
    {
      role: 'tool-call',
      content: '',
      toolCall: {
        id: 'call-exports-check',
        name: 'exports_check',
        arguments: { package: '@corvidae/cinder' },
      },
    },
    {
      role: 'tool-result',
      content: '',
      metadata: {
        'cinder:artifact': {
          type: 'code',
          content: '{\n  "status": "ok",\n  "drift": false\n}',
          language: 'json',
          title: 'Exports report',
        },
      },
      toolResult: {
        callId: 'call-exports-check',
        outcome: 'success',
        content: { status: 'ok', drift: false },
      },
    },
    {
      role: 'assistant',
      content: 'The exports map is current and the component subpaths are available.',
    },
    {
      role: 'assistant',
      content: 'Here is the first duplicate artifact.',
      metadata: {
        'cinder:artifact': {
          type: 'code',
          content: 'const duplicate = 1;',
          language: 'typescript',
          title: 'Duplicate report',
        },
      },
    },
    {
      role: 'assistant',
      content: 'Here is the second duplicate artifact.',
      metadata: {
        'cinder:artifact': {
          type: 'code',
          content: 'const duplicate = 2;',
          language: 'typescript',
          title: 'Duplicate report',
        },
      },
    },
    {
      role: 'assistant',
      content: 'This artifact has a blank title.',
      metadata: {
        'cinder:artifact': {
          type: 'code',
          content: 'const fallbackTitle = true;',
          language: 'typescript',
          title: '   ',
        },
      },
    },
    {
      role: 'assistant',
      content: 'This artifact has a very long title.',
      metadata: {
        'cinder:artifact': {
          type: 'code',
          content: 'const longTitle = true;',
          language: 'typescript',
          title: longArtifactTitle,
        },
      },
    },
    {
      role: 'tool-call',
      content: '',
      toolCall: {
        id: 'call-direct-artifact',
        name: 'collect_summary',
        arguments: { target: 'direct' },
      },
      metadata: {
        'cinder:artifact': {
          type: 'code',
          content: 'const callMetadataWins = true;',
          language: 'typescript',
          title: 'Call metadata artifact',
        },
      },
    },
    {
      role: 'tool-result',
      content: '',
      metadata: {
        'cinder:artifact': {
          type: 'code',
          content: 'const resultMetadataLoses = true;',
          language: 'typescript',
          title: 'Result metadata artifact',
        },
      },
      toolResult: {
        callId: 'call-direct-artifact',
        outcome: 'success',
        content: { status: 'ignored-artifact' },
      },
    },
    {
      role: 'tool-call',
      content: '',
      toolCall: {
        id: 'call-group-one',
        name: 'collect_first',
        arguments: { target: 'first' },
      },
    },
    {
      role: 'tool-result',
      content: '',
      metadata: {
        'cinder:artifact': {
          type: 'code',
          content: 'const groupedOne = true;',
          language: 'typescript',
          title: 'Grouped artifact one',
        },
      },
      toolResult: {
        callId: 'call-group-one',
        outcome: 'success',
        content: { status: 'first' },
      },
    },
    {
      role: 'tool-call',
      content: '',
      toolCall: {
        id: 'call-group-two',
        name: 'collect_second',
        arguments: { target: 'second' },
      },
    },
    {
      role: 'tool-result',
      content: '',
      metadata: {
        'cinder:artifact': {
          type: 'code',
          content: 'const groupedTwo = true;',
          language: 'typescript',
          title: 'Grouped artifact two',
        },
      },
      toolResult: {
        callId: 'call-group-two',
        outcome: 'success',
        content: { status: 'second' },
      },
    },
  );

  let selectedArtifact = $state<ResolvedChatArtifact | undefined>();
  let externalSelectedArtifact = $state<ResolvedChatArtifact | undefined>();
  let activeConversationId = $state('basic-chat');
  const conversationSummaries = $derived([
    deriveConversationSummary(basicConversation),
    deriveConversationSummary(pairedConversation),
  ]);
  const activeConversation = $derived(
    activeConversationId === pairedConversation.id ? pairedConversation : basicConversation,
  );

  let approvalResolutions = $state.raw<{ toolCallId: string; resolution: ApprovalResolution }[]>(
    [],
  );

  function handleSubmit(event: ChatSubmitEvent): void {
    basicConversation = appendUserMessage(basicConversation, event.message.content);
  }

  function handleApprovalResolve(toolCallId: string, resolution: ApprovalResolution): void {
    approvalResolutions = [...approvalResolutions, { toolCallId, resolution }];
  }
</script>

<div class="chat-fixture-stack">
  <div style="height: 34rem;">
    <Chat
      id="fixture-basic-chat"
      conversation={basicConversation}
      capabilities={{ attachments: false }}
      onsubmit={handleSubmit}
    />
  </div>

  <div style="height: 34rem;">
    <Chat
      id="fixture-tool-approval-chat"
      conversation={approvalConversation}
      capabilities={{ attachments: false }}
      {adapter}
      onapprovalresolve={handleApprovalResolve}
    />
    <pre data-testid="approval-resolution-log">{JSON.stringify(approvalResolutions)}</pre>
  </div>

  <div class="chat-layout-fixture-container">
    <section class="chat-layout-fixture" data-testid="chat-conversation-layout">
      <aside class="chat-layout-fixture__sidebar">
        <ChatConversationList
          conversations={conversationSummaries}
          {activeConversationId}
          onSelectConversation={(conversationId) => (activeConversationId = conversationId)}
        />
      </aside>

      <div class="chat-layout-fixture__main">
        <Chat
          id="fixture-conversation-layout-chat"
          conversation={activeConversation}
          capabilities={{ attachments: false }}
          onsubmit={handleSubmit}
        >
          {#snippet header()}
            <ChatConversationHeader conversation={activeConversation} />
          {/snippet}
        </Chat>
      </div>
    </section>
  </div>

  <div style="height: 34rem;" data-testid="chat-default-artifact-layout">
    <Chat
      id="fixture-default-artifact-chat"
      conversation={pairedConversation}
      capabilities={{ attachments: false }}
      {adapter}
    />
  </div>

  <section class="chat-public-flex-shell" data-testid="chat-public-flex-shell">
    <header class="chat-public-sizing-header">Documented flex shell</header>
    <Chat
      id="fixture-public-flex-chat"
      class="chat-public-flex-surface chat-public-theme-surface"
      conversation={pairedConversation}
      capabilities={{ attachments: false }}
      {adapter}
    />
  </section>

  <section class="chat-public-grid-shell" data-testid="chat-public-grid-shell">
    <header class="chat-public-sizing-header">Documented grid shell</header>
    <Chat
      id="fixture-public-grid-chat"
      class="chat-public-grid-surface"
      conversation={pairedConversation}
      capabilities={{ attachments: false }}
      {adapter}
    />
  </section>

  <section class="chat-public-fixed-shell" data-testid="chat-public-fixed-shell">
    <Chat
      id="fixture-public-fixed-chat"
      class="chat-public-theme-surface"
      style="block-size: 100%; min-block-size: 0;"
      conversation={pairedConversation}
      capabilities={{ attachments: false }}
      {adapter}
    />
  </section>

  <div style="height: 34rem;" data-testid="chat-external-artifact-layout">
    <ChatArtifactLayout
      instanceId="fixture-tool-call-artifact"
      open={externalSelectedArtifact !== undefined}
      panelTitle={externalSelectedArtifact?.title}
      onclose={() => (externalSelectedArtifact = undefined)}
    >
      <Chat
        id="fixture-tool-call-chat"
        conversation={pairedConversation}
        capabilities={{ attachments: false }}
        {adapter}
        onartifactopen={(artifact) => (externalSelectedArtifact = artifact)}
      >
        {#snippet messageActions(context: ChatRowContext)}
          {#if context.artifact}
            <Button
              size="xs"
              variant="ghost"
              data-testid="custom-artifact-action"
              onclick={() => (selectedArtifact = context.artifact)}
            >
              Custom artifact action
            </Button>
          {/if}
        {/snippet}
      </Chat>

      {#snippet panel()}
        {#if externalSelectedArtifact}
          <ArtifactViewer
            type={externalSelectedArtifact.type}
            content={externalSelectedArtifact.content}
            title={externalSelectedArtifact.title}
            {...externalSelectedArtifact.language === undefined
              ? {}
              : { language: externalSelectedArtifact.language }}
          />
        {/if}
      {/snippet}
    </ChatArtifactLayout>
    <span class="cinder-sr-only" data-testid="custom-selected-artifact">
      {selectedArtifact?.title ?? ''}
    </span>
  </div>
</div>

<style>
  .chat-fixture-stack {
    display: grid;
    gap: 1rem;
  }

  .chat-layout-fixture-container {
    container-type: inline-size;
  }

  .chat-layout-fixture {
    display: grid;
    grid-template-columns: minmax(11rem, 16rem) minmax(0, 1fr);
    height: 34rem;
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--cinder-border-muted);
  }

  .chat-layout-fixture__sidebar {
    min-width: 0;
    overflow: auto;
    padding: var(--cinder-space-2);
    border-inline-end: 1px solid var(--cinder-border-muted);
  }

  .chat-layout-fixture__main {
    min-width: 0;
    min-height: 0;
  }

  .chat-public-flex-shell,
  .chat-public-grid-shell {
    block-size: 26rem;
    min-inline-size: 0;
    overflow: hidden;
    border: 1px solid var(--cinder-border-muted);
  }

  .chat-public-flex-shell {
    display: flex;
    flex-direction: column;
  }

  .chat-public-grid-shell {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
  }

  .chat-public-sizing-header {
    padding: var(--cinder-space-2);
    color: var(--cinder-text-muted);
    border-block-end: 1px solid var(--cinder-border-muted);
  }

  .chat-public-flex-shell :global(.chat-public-flex-surface) {
    flex: 1;
    min-block-size: 0;
  }

  .chat-public-grid-shell :global(.chat-public-grid-surface) {
    min-block-size: 0;
  }

  .chat-public-flex-shell :global(.chat-public-theme-surface),
  .chat-public-fixed-shell :global(.chat-public-theme-surface) {
    --_chat-public-theme-outline: color-mix(in oklch, var(--cinder-accent-solid), transparent 35%);
    outline: 2px solid var(--_chat-public-theme-outline);
    outline-offset: -2px;
  }

  @container (max-width: 36rem) {
    .chat-layout-fixture {
      grid-template-columns: 1fr;
      grid-template-rows: auto minmax(0, 1fr);
    }

    .chat-layout-fixture__sidebar {
      max-block-size: 9rem;
      border-inline-end: 0;
      border-block-end: 1px solid var(--cinder-border-muted);
    }
  }
</style>
