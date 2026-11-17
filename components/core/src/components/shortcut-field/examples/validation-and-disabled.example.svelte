<script lang="ts" module>
  export const title = 'Validation and disabled state';
  export const description =
    'validate rejects a reserved combination through the shared FormField error region; a second field shows the disabled, inert state.';
</script>

<script lang="ts">
  import { ShortcutField } from '@lostgradient/cinder';

  let shortcut = $state<string[]>(['Meta', 'K']);

  function rejectReserved(next: string[]): string | undefined {
    return next.join('+') === 'Meta+Q' ? 'Meta+Q is reserved by the operating system.' : undefined;
  }
</script>

<div style="display: flex; flex-direction: column; gap: 1rem;">
  <ShortcutField
    id="validated-shortcut"
    label="Open command palette"
    bind:value={shortcut}
    validate={rejectReserved}
  />
  <ShortcutField id="locked-shortcut" label="Locked shortcut" value={['Control', 'L']} disabled />
</div>
