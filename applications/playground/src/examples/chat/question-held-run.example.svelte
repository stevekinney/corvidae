<script lang="ts" module>
  export const title = 'Question with Undo, a run’s own words';
  export const description =
    'The question a run’s page draws: the same Undo window with the page’s words. The picked choice says “Selected” under its label and the others show their labels alone; the one inline line reads “Answer sent: Production. Undo for 5 s.” with the note of what happens next, and an Undo action.';
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

  // The example starts with Production already picked, so the held state is what the page shows.
  // The count waits while focus is inside the question, as it does on the run’s page.
  $effect(() => {
    const choice = host?.querySelectorAll<HTMLButtonElement>('.chat-question-choices button')[1];
    choice?.click();
    host
      ?.querySelector('.chat-question')
      ?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
</script>

<div bind:this={host} style="max-inline-size: 48rem; display: grid; gap: 0.75rem;">
  <p style="margin: 0; font-weight: 600;">Which environment should the release go to?</p>
  <ChatQuestion
    id="question-held-run"
    {schema}
    undoMilliseconds={5000}
    holdCopy={{
      held: (label, seconds) => `Answer sent: ${label}. Undo for ${String(seconds)} s.`,
      undo: () => 'Undo',
      sent: (label) => `You answered: ${label}`,
      selected: 'Selected',
      note: 'Request human input continues once a provider is connected.',
    }}
    onSubmit={() => {}}
  />
</div>
