<script lang="ts">
  import SelectionPopover from '../../components/selection-popover/selection-popover.svelte';

  // The parent owns `open` and `position`, as a real caller does. Testing Library's `rerender`
  // replaces the whole props object, which also wakes the `actions` subscription and hides a
  // focus effect that listens to `actions` alone; toggling state here does not.
  let open = $state(false);
  let position = $state<{ x: number; y: number; height?: number } | null>(null);

  export function show(): void {
    position = { x: 120, y: 80, height: 20 };
    open = true;
  }
</script>

<SelectionPopover id="selection-quote-fixture" {open} {position} onClose={() => (open = false)}>
  {#snippet actions({ close })}
    <button type="button" onclick={close}>Quote</button>
  {/snippet}
</SelectionPopover>
