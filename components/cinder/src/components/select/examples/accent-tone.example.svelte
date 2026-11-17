<script lang="ts" module>
  export const title = 'Accent tone for the select that names the target';
  export const description =
    'tone="accent" draws the value in the accent colour and weight, for the one select that says what its container is about to do, such as the agent a new chat is with. The Permissions select below it only sets an option and keeps the default tone.';
</script>

<script lang="ts">
  import { Select } from '@lostgradient/cinder';

  const agents = [
    { value: 'assistant', label: 'Assistant' },
    { value: 'tool-runner', label: 'Tool runner' },
  ];
  const permissions = [
    { value: 'asks', label: 'On changes asks' },
    { value: 'all', label: 'Allow all' },
  ];

  let agent = $state('assistant');
  let permission = $state('asks');
</script>

<div
  style="display: flex; flex-direction: column; gap: var(--cinder-space-2); padding: var(--cinder-space-2) var(--cinder-pad-control); border: 1px solid var(--cinder-border); border-radius: var(--cinder-radius-lg); inline-size: 24rem; max-inline-size: 100%"
>
  <div>
    <Select
      id="accent-agent"
      label="Agent"
      labelVisible={false}
      presentation="listbox"
      variant="ghost"
      tone="accent"
      size="sm"
      options={agents}
      bind:value={agent}
    />
  </div>
  <div style="padding-block: var(--cinder-space-2); color: var(--cinder-text-muted)">
    Message Assistant…
  </div>
  <div>
    <Select
      id="accent-permission"
      label="Permissions"
      labelVisible={false}
      presentation="listbox"
      variant="ghost"
      size="sm"
      valuePrefix="Permissions"
      options={permissions}
      bind:value={permission}
    />
  </div>
</div>
