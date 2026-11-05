<script lang="ts" module>
  export const title = 'Question with choices';
  export const description =
    'A pick-one question with the payload’s own descriptions under each choice, and one field to type your own answer. Picking a choice answers at once.';
</script>

<script lang="ts">
  import { ChatQuestion } from '@lostgradient/chat';

  const schema = {
    anyOf: [{ enum: ['staging', 'production'] }, { type: 'string', maxLength: 500 }],
    'x-allowOther': true,
    'x-labels': { staging: 'Staging', production: 'Production' },
    'x-descriptions': {
      staging: 'Deploys to the staging site',
      production: 'Deploys to the live site',
    },
  };

  let answered = $state('');
</script>

<div style="max-inline-size: 48rem; display: grid; gap: 0.75rem;">
  <p style="margin: 0; font-weight: 600;">Which environment should the release go to?</p>
  <ChatQuestion
    id="question-choice"
    {schema}
    onSubmit={(value) => {
      answered = String(value);
    }}
  />
  {#if answered !== ''}<p style="margin: 0;">Sent: {answered}</p>{/if}
</div>
