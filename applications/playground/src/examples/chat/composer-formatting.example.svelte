<script lang="ts" module>
  export const title = 'Composer formatting while it has focus';
  export const description =
    'The composer styles Markdown in place (the bold span shows styled) and, only once the box has focus, draws a formatting toolbar with the words of its shortcuts: ⌘B bold, ⌘I italic, ⌘E code and ⌘⇧K link. Plain ⌘K is left to the host’s command palette.';
</script>

<script lang="ts">
  import { onMount } from 'svelte';

  import { ChatInput } from '@lostgradient/chat';
  import { Avatar, Select } from '@lostgradient/cinder';

  const AGENTS = [
    {
      value: 'tool-runner',
      label: 'Tool runner',
      description: 'Looks an order up, then asks for approval to refund it.',
    },
  ];
  const MODELS = [{ value: 'sonnet', label: 'Claude Sonnet 5.5' }];
  const EFFORTS = [{ value: 'medium', label: 'Medium' }];
  const PERMISSIONS = [{ value: 'on-changes', label: 'On changes asks' }];
  let agent = $state('tool-runner');
  let model = $state('sonnet');
  let effort = $state('medium');
  let permissions = $state('on-changes');
  let value = $state(
    'Please refund order 4471, it arrived damaged. The carrier flagged it. **Check the photo** first.',
  );
  let input: ReturnType<typeof ChatInput> | undefined;

  onMount(() => input?.focus());
</script>

<ChatInput
  id="composer-formatting"
  bind:this={input}
  bind:value
  placeholder="Message Tool runner…"
  formattingToolbar
>
  {#snippet header()}
    <Select
      id="composer-formatting-agent"
      variant="ghost"
      presentation="listbox"
      size="sm"
      label="Agent"
      labelVisible={false}
      options={AGENTS}
      bind:value={agent}
    >
      {#snippet leading(option)}
        <Avatar size="xs" name={option.label} alt="" />
      {/snippet}
    </Select>
  {/snippet}
  {#snippet controls()}
    <Select
      id="composer-formatting-model"
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
      id="composer-formatting-effort"
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
      id="composer-formatting-permissions"
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
</ChatInput>
