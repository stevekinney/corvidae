<script lang="ts" module>
  export const title = 'Question with a structured answer';
  export const description =
    'When the agent asks for fields, the answer is a form. Picking a value sends nothing; the host’s own Send answer button, beside what the agent does next, commits it.';
</script>

<script lang="ts">
  import { Button } from '@lostgradient/cinder';
  import { ChatQuestion } from '@lostgradient/chat';

  const schema = {
    type: 'object',
    properties: {
      environment: {
        type: 'string',
        title: 'Environment',
        enum: ['staging', 'production'],
      },
      version: { type: 'string', title: 'Version' },
      announce: { type: 'boolean', title: 'Tell the team in #releases' },
    },
    required: ['environment', 'version'],
  };

  let sent = $state('');
</script>

<div style="max-inline-size: 36rem; display: grid; gap: 1rem;">
  <p style="margin: 0; font-weight: 600;">Confirm the release details</p>
  <ChatQuestion
    id="question-structured"
    {schema}
    externalSubmit
    onSubmit={(value) => {
      sent = JSON.stringify(value);
    }}
  />
  <div style="display: flex; align-items: center; gap: 0.75rem;">
    <span style="flex: 1; font-size: 0.8125rem;">The agent continues as soon as you answer.</span>
    <Button type="submit" form="question-structured-form" variant="primary" label="Send answer" />
  </div>
  {#if sent !== ''}<pre style="margin: 0;">{sent}</pre>{/if}
</div>
