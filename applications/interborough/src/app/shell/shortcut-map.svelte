<script lang="ts">
  /**
   * The map of every keyboard shortcut, opened with `?`. It lists the registry
   * (`../../lib/shortcuts.ts`) through Cinder's `KeyboardShortcuts`, so there is no second list to
   * keep: a shortcut a later page registers appears here, and so do the keys a Cinder component
   * handles itself.
   */
  import { KeyboardShortcuts, Modal } from '@lostgradient/cinder';

  import type { ShortcutRegistry } from '../../lib/shortcuts.ts';
  import { SHORTCUT_COPY } from '../copy.ts';

  interface ShortcutMapProps {
    registry: ShortcutRegistry;
    open: boolean;
  }

  let { registry, open = $bindable(false) }: ShortcutMapProps = $props();

  // Read when the map opens, so it lists what is registered at that moment.
  const groups = $derived(open ? registry.groups() : []);
</script>

<Modal bind:open title={SHORTCUT_COPY.mapTitle} onDismiss={() => (open = false)}>
  <!--
    The map is longer than a short window, so it scrolls, and a region that scrolls must be reachable
    from the keyboard. Cinder's modal body scrolls without being focusable, so the list scrolls here
    instead, and takes focus.
  -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="weft-shortcut-map" role="region" aria-label={SHORTCUT_COPY.mapTitle} tabindex="0">
    <KeyboardShortcuts
      groups={groups.map((group) => ({ ...group, shortcuts: [...group.shortcuts] }))}
    />
  </div>
</Modal>
