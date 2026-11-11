<script lang="ts" module>
  export const title = 'Model select grouped by provider';
  export const description =
    'One select grouped by provider. Anthropic lists its models with abilities under each name and a check on the chosen one; providers that are not connected keep a heading with non-selectable text and a link. Closed, the trigger reads the model and its provider.';
</script>

<script lang="ts">
  import { Select } from '@lostgradient/cinder';
  import { createRawSnippet } from 'svelte';

  const models = [
    {
      value: 'opus',
      label: 'Claude Opus 5.5',
      description: 'Most capable, tools, images, 1M context',
      group: 'anthropic',
    },
    {
      value: 'sonnet',
      label: 'Claude Sonnet 5.5',
      description: 'Balanced, tools, images, 1M context',
      group: 'anthropic',
      triggerSuffix: 'Anthropic',
    },
    {
      value: 'haiku',
      label: 'Claude Haiku 5.5',
      description: 'Fastest, tools, 200K context',
      group: 'anthropic',
    },
  ];

  const gptMessage = createRawSnippet(() => ({
    render: () =>
      '<span>Connect in <a href="/settings/models">Settings › Models</a> to choose a GPT model.</span>',
  }));
  const geminiMessage = createRawSnippet(() => ({
    render: () =>
      '<span>Connect in <a href="/settings/models">Settings › Models</a> to choose a Gemini model.</span>',
  }));

  let model = $state('sonnet');
</script>

<Select
  id="model-picker"
  label="Model"
  presentation="listbox"
  options={models}
  groups={[
    { name: 'anthropic', heading: 'Anthropic' },
    { name: 'openai', heading: 'OpenAI, not connected', divided: true, message: gptMessage },
    { name: 'gemini', heading: 'Gemini, not connected', divided: true, message: geminiMessage },
  ]}
  bind:value={model}
/>
