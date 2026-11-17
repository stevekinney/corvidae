<script lang="ts" module>
  export const title = 'Every control that changes something';
  export const description =
    'Button, Toggle, Checkbox and Select opt in with mutating. Under a stale region each one keeps focus, ignores the press and is described by the reason. The page words the reason, and the filter beside them, which only reads, stays live.';
</script>

<script lang="ts">
  import { Button, Checkbox, Input, Select, StaleRegion, Toggle } from '@lostgradient/cinder';

  let checked = $state(true);
  let active = $state(true);
  let filter = $state('');
  let asks = $state<'never' | 'changes' | 'always'>('changes');
</script>

<StaleRegion reason="Off until storage answers.">
  <div style="display: grid; gap: 0.75rem; max-inline-size: 22rem;">
    <Input id="filter-keys" label="Filter" placeholder="Filter keys" bind:value={filter} />
    <Toggle id="active-switch" label="Active" bind:checked={active} mutating />
    <Checkbox label="Tool is on" bind:checked mutating />
    <Select
      id="default-asks"
      label="Default asks"
      mutating
      bind:value={asks}
      options={[
        { value: 'never', label: 'Never' },
        { value: 'changes', label: 'On changes' },
        { value: 'always', label: 'Always' },
      ]}
    />
    <div style="display: flex; gap: 0.5rem;">
      <Button mutating variant="primary">Save value</Button>
      <Button>Copy key</Button>
    </div>
  </div>
</StaleRegion>
