<script lang="ts" module>
  export const title = 'Question with Undo';
  export const description =
    'A choice picked with a five-second Undo window: the choice shows selected and one inline line reads “Answered Staging, Undo (5s)”. The count pauses while focus or the pointer is inside the question.';
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

  // The example starts with Staging already picked, so the held state is what the page shows. The
  // count waits while focus is inside the question, so the focus stays on the choice and the line
  // keeps reading “Undo (5 s)”.
  $effect(() => {
    const choice = host?.querySelector<HTMLElement>('.chat-question-choices [role="radio"]');
    choice?.click();
    choice?.focus();
    // A window that does not have focus raises no focus event for `focus()`, so the question is told
    // the person is in it the way the browser would tell it.
    host
      ?.querySelector('.chat-question')
      ?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
</script>

<div bind:this={host} style="max-inline-size: 48rem; display: grid; gap: 0.75rem;">
  <p style="margin: 0; font-weight: 600;">Which environment should the release go to?</p>
  <ChatQuestion id="question-held" {schema} undoMilliseconds={5000} onSubmit={() => {}} />
</div>
