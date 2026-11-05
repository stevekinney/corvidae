<script lang="ts" module>
  export const title = 'Question answered';
  export const description =
    'The same question once its Undo window has ended: the run has the answer and the line reads “You answered: Staging”.';
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

  let host = $state<HTMLElement | undefined>();

  // A window too short to see: the example picks Staging and lands on the sent line.
  $effect(() => {
    host?.querySelector<HTMLButtonElement>('.chat-question-choices button')?.click();
  });
</script>

<div bind:this={host} style="max-inline-size: 48rem; display: grid; gap: 0.75rem;">
  <p style="margin: 0; font-weight: 600;">Which environment should the release go to?</p>
  <ChatQuestion id="question-sent" {schema} undoMilliseconds={100} onSubmit={() => {}} />
</div>
