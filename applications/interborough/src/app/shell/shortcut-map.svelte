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
  <KeyboardShortcuts
    groups={groups.map((group) => ({ ...group, shortcuts: [...group.shortcuts] }))}
  />
</Modal>
