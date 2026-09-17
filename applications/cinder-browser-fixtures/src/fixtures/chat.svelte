<script lang="ts">
  import {
    ArtifactViewer,
    Chat,
    ChatArtifactLayout,
    appendAssistantMessage,
    appendMessages,
    appendUserMessage,
    createConversation,
    type ChatArtifact,
    type ChatRowContext,
    type ChatSubmitEvent,
    type ChatAdapter,
  } from '@repo/chat';
  import { Button } from '@repo/cinder';

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
          schema: { environment: 'production', version: '2.4.1', replicas: 3 },
        },
      },
    },
  );

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
        arguments: { package: '@repo/cinder' },
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
  );

  let selectedArtifact = $state<ChatArtifact | undefined>();

  function handleSubmit(event: ChatSubmitEvent): void {
    basicConversation = appendUserMessage(basicConversation, event.message.content);
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
      onapprove={() => {}}
      ondeny={() => {}}
    />
  </div>

  <div style="height: 34rem;">
    <ChatArtifactLayout
      instanceId="fixture-tool-call-artifact"
      open={selectedArtifact !== undefined}
      panelTitle={selectedArtifact?.title}
      onclose={() => (selectedArtifact = undefined)}
    >
      <Chat
        id="fixture-tool-call-chat"
        conversation={pairedConversation}
        capabilities={{ attachments: false }}
        {adapter}
      >
        {#snippet messageActions(context: ChatRowContext)}
          {#if context.artifact}
            <Button size="xs" variant="ghost" onclick={() => (selectedArtifact = context.artifact)}>
              Open artifact
            </Button>
          {/if}
        {/snippet}
      </Chat>

      {#snippet panel()}
        {#if selectedArtifact}
          <ArtifactViewer {...selectedArtifact} />
        {/if}
      {/snippet}
    </ChatArtifactLayout>
  </div>
</div>

<style>
  .chat-fixture-stack {
    display: grid;
    gap: 1rem;
  }
</style>
