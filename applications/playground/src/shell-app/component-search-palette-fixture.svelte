<script lang="ts" module>
  /** What the trigger did to its palette, recorded across mounts by `component-search.test.ts`. */
  export const paletteFixtureLedger = { mounts: 0, opens: 0 };
</script>

<script lang="ts">
  /*
   * Stands in for `component-search-palette.svelte` in the trigger's tests: the
   * same props, no CommandPalette, and a ledger of how often it mounted and how
   * often `open` turned true.
   */
  type Props = {
    open: boolean;
    components: readonly string[];
    returnFocusTo: HTMLElement | null;
  };

  let { open = $bindable(false), components, returnFocusTo }: Props = $props();

  paletteFixtureLedger.mounts += 1;

  $effect(() => {
    if (open) paletteFixtureLedger.opens += 1;
  });
</script>

<div
  data-testid="palette-fixture"
  data-open={open ? '' : undefined}
  data-components={components.length}
  data-returns-focus={returnFocusTo === null ? undefined : ''}
></div>
