<script lang="ts" module>
  export const title = 'Composer with an attached file';
  export const description =
    'An attached file is a removable chip with its name and size, between the text and the control row.';
</script>

<script lang="ts">
  import { onMount } from 'svelte';

  import { ChatInput } from '@lostgradient/chat';
  import { Avatar, Select } from '@lostgradient/cinder';

  const AGENTS = [{ value: 'tool-runner', label: 'Tool runner' }];
  const MODELS = [{ value: 'sonnet', label: 'Claude Sonnet 5.5' }];
  const EFFORTS = [{ value: 'medium', label: 'Medium' }];
  const PERMISSIONS = [{ value: 'on-changes', label: 'On changes asks' }];
  let agent = $state('tool-runner');
  let model = $state('sonnet');
  let effort = $state('medium');
  let permissions = $state('on-changes');
  let value = $state('Please refund order 4471, it arrived damaged.');
  let input: ReturnType<typeof ChatInput> | undefined;

  onMount(() => {
    input?.addFiles([
      new File([new Uint8Array(240 * 1024)], 'refund-photo.png', { type: 'image/png' }),
    ]);
  });
</script>

<ChatInput id="composer-attachment" bind:this={input} bind:value placeholder="Message Tool runner…">
  {#snippet header()}
    <Select
      id="composer-attachment-agent"
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
      id="composer-attachment-model"
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
      id="composer-attachment-effort"
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
      id="composer-attachment-permissions"
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
