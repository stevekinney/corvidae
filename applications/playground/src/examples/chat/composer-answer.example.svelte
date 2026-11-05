<script lang="ts" module>
  export const title = 'Composer in answer mode';
  export const description =
    'A question is waiting: the composer reads Choose an answer above, or type your own…, and its button is Answer in place of Send. Picking a choice sends it at once.';
</script>

<script lang="ts">
  import {
    appendToolCall,
    appendToolResult,
    appendUserMessage,
    Chat,
    createConversation,
  } from '@lostgradient/chat';
  import { Meter, Select } from '@lostgradient/cinder';

  const MODELS = [
    { value: 'sonnet', label: 'Claude Sonnet 5.5' },
    { value: 'haiku', label: 'Claude Haiku 5' },
  ];
  const EFFORTS = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ];
  const PERMISSIONS = [
    {
      value: 'on-changes',
      label: 'On changes asks',
      description: 'Tools set to On changes ask before they run.',
    },
    {
      value: 'allow-all',
      label: 'Allow all',
      description:
        'Skips the On changes asks for this chat. Tools set to Always still ask; Blocked tools stay blocked.',
    },
  ];
  let model = $state('sonnet');
  let effort = $state('medium');
  let permissions = $state('on-changes');

  const conversation = appendToolResult(
    appendToolCall(
      appendUserMessage(
        createConversation({ id: 'composer-answer' }),
        'Ship the release notes fix.',
      ),
      { id: 'ask', name: 'requestHumanInput', arguments: {} },
    ),
    {
      callId: 'ask',
      outcome: 'action_required',
      content: null,
      action: {
        type: 'input',
        message: 'Which environment should the release go to?',
        schema: {
          anyOf: [{ enum: ['staging', 'production'] }, { type: 'string', maxLength: 500 }],
          'x-allowOther': true,
          'x-labels': { staging: 'Staging', production: 'Production' },
          'x-descriptions': {
            staging: 'Deploys to the staging site',
            production: 'Deploys to the live site',
          },
        },
      },
    },
  );
</script>

<div style="block-size: 26rem;">
  <Chat
    id="composer-answer"
    {conversation}
    surfaceMode="transparent"
    composerPlaceholder="Message Tool runner…"
    answerInComposer
    onInputSubmit={() => undefined}
  >
    {#snippet composerControls()}
      <Select
        id="composer-answer-model"
        variant="ghost"
        presentation="listbox"
        size="sm"
        label="Model"
        labelVisible={false}
        valuePrefix="Model"
        options={MODELS}
        bind:value={model}
      />
      <Select
        id="composer-answer-effort"
        variant="ghost"
        presentation="listbox"
        size="sm"
        label="Effort"
        labelVisible={false}
        valuePrefix="Effort"
        options={EFFORTS}
        bind:value={effort}
      />
      <Select
        id="composer-answer-permissions"
        variant="ghost"
        presentation="listbox"
        size="sm"
        label="Permissions"
        labelVisible={false}
        valuePrefix="Permissions"
        options={PERMISSIONS}
        bind:value={permissions}
      />
    {/snippet}
    {#snippet composerActions()}
      <span class="context-meter" title="76K of 200K tokens">
        <Meter size="sm" value={38} ariaLabel="Context 38%" />
        <span aria-hidden="true">38%</span>
      </span>
    {/snippet}
  </Chat>
</div>

<style>
  .context-meter {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
  }

  .context-meter :global(.cinder-meter) {
    inline-size: 2.25rem;
  }
</style>
