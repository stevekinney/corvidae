<script lang="ts" module>
  export const title = 'First-run checklist';
  export const description =
    'variant="checklist" is a card of rows with a heading, a "N of M done" counter and an action per step. Steps complete in any order: done marks a step, and the first step that is not done is current.';
</script>

<script lang="ts">
  import { Button, type StepItem, type StepItemState, Steps } from '@lostgradient/cinder';

  let connected = $state(false);

  const steps = $derived<StepItem[]>([
    {
      id: 'provider',
      label: 'Connect a provider',
      description: connected
        ? 'Anthropic is connected.'
        : 'Agents need a model provider before they can answer.',
      done: connected,
      action: connected ? undefined : provider,
    },
    {
      id: 'agent',
      label: 'Create an agent, or start from Assistant',
      description: 'Assistant works now; other agents need a provider.',
      action: agent,
    },
    {
      id: 'hello',
      label: 'Say hello',
      description: 'Send a first message to see a chat run end to end.',
      action: hello,
    },
  ]);
</script>

{#snippet provider(state: StepItemState)}
  <Button
    variant={state === 'current' ? 'primary' : 'secondary'}
    label="Connect a provider"
    onclick={() => (connected = true)}
  />
{/snippet}
{#snippet agent(state: StepItemState)}
  <Button variant={state === 'current' ? 'primary' : 'secondary'} label="Create an agent" />
{/snippet}
{#snippet hello(state: StepItemState)}
  <Button variant={state === 'current' ? 'primary' : 'secondary'} label="Start a chat" />
{/snippet}

<Steps {steps} variant="checklist" heading="Get started" />
