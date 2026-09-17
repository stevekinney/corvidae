<script lang="ts">
  import { Button, Checkbox, Drawer, Select } from '@repo/cinder';
  import type { DrawerPlacement, DrawerSize } from '@repo/cinder';

  let open = $state(false);
  let triggerRef: HTMLElement | null = $state(null);
  let placement = $state<DrawerPlacement>('right');
  let size = $state<DrawerSize>('md');
  let useTriggerRef = $state(true);

  const placementOptions: { value: DrawerPlacement; label: string }[] = [
    { value: 'right', label: 'right' },
    { value: 'left', label: 'left' },
    { value: 'bottom', label: 'bottom' },
  ];
  const sizeOptions: { value: DrawerSize; label: string }[] = [
    { value: 'sm', label: 'sm' },
    { value: 'md', label: 'md' },
    { value: 'lg', label: 'lg' },
    { value: 'xl', label: 'xl' },
  ];
</script>

<div style="display: flex; flex-direction: column; gap: 1rem; max-width: 32rem;">
  <div style="display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end;">
    <Select id="placement" bind:value={placement} options={placementOptions} label="Placement" />
    <Select id="size" bind:value={size} options={sizeOptions} label="Size" />
    <Checkbox id="use-trigger-ref" bind:checked={useTriggerRef} label="Use triggerRef" />
  </div>

  <Button
    label="Open drawer"
    onclick={(event) => {
      triggerRef = useTriggerRef ? event.currentTarget : null;
      open = true;
    }}
  />
</div>

<Drawer
  bind:open
  {placement}
  {size}
  title="Drawer panel"
  triggerRef={useTriggerRef ? triggerRef : null}
>
  <p>This is the drawer body. You can put any content here.</p>
  <p>Current settings: placement={placement}, size={size}.</p>

  {#snippet footer()}
    <div style="display: flex; gap: 0.5rem;">
      <Button variant="secondary" label="Cancel" onclick={() => (open = false)} />
      <Button label="Confirm" onclick={() => (open = false)} />
    </div>
  {/snippet}
</Drawer>
