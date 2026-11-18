<script lang="ts" module>
  export const title = 'Agent picker: descriptions, notes, an unavailable group and a footer';
  export const description =
    'A ghost listbox select. Each agent has a name and a one-sentence description; model agents show "Needs a provider" while none is connected; agents held back by a disabled plugin sit under "Unavailable" with the reason and cannot be picked; the one link is a footer outside the listbox with its own focus stop.';
</script>

<script lang="ts">
  import { Select } from '@lostgradient/cinder';

  const agents = [
    {
      value: 'assistant',
      label: 'Assistant',
      description: 'Answers every message with the same scripted reply.',
    },
    {
      value: 'tool-runner',
      label: 'Tool runner',
      description: 'Looks an order up, then asks for approval to refund it.',
      note: 'Needs a provider',
    },
    {
      value: 'human-input',
      label: 'Request human input',
      description: 'Stops to ask a person a question before it goes on.',
      note: 'Needs a provider',
    },
    {
      value: 'workflow-author',
      label: 'Workflow author',
      description: 'Writes a workflow from a description.',
      note: 'Needs a provider',
    },
    {
      value: 'echo',
      label: 'Echo',
      description: 'Repeats the last message it was sent.',
    },
    {
      value: 'model-switcher',
      label: 'Model switcher',
      description: 'Changes its model part-way through a chat.',
      note: 'Needs a provider',
    },
    {
      value: 'release-helper',
      label: 'Release helper',
      description: 'Plugin Demo is disabled',
      disabled: true,
      group: 'unavailable',
    },
    {
      value: 'changelog-writer',
      label: 'Changelog writer',
      description: 'Plugin Demo is disabled',
      disabled: true,
      group: 'unavailable',
    },
    {
      value: 'nightly-archiver',
      label: 'Nightly archiver',
      suffix: 'no description',
    },
  ];

  let agent = $state('assistant');
</script>

<Select
  id="agent-picker"
  label="Agent"
  labelVisible={false}
  presentation="listbox"
  variant="ghost"
  size="sm"
  options={agents}
  groups={[{ name: 'unavailable', heading: 'Unavailable', divided: true }]}
  bind:value={agent}
>
  {#snippet leading(option)}
    <span
      aria-hidden="true"
      style="display: inline-grid; place-items: center; inline-size: 1.25rem; block-size: 1.25rem; border-radius: 50%; background: var(--cinder-surface-inset); font-size: var(--cinder-text-xs)"
      >{option.label.slice(0, 1)}</span
    >
  {/snippet}
  {#snippet footer()}
    <a href="/plugins/demo">Enable the Demo plugin and restart</a>
  {/snippet}
</Select>
