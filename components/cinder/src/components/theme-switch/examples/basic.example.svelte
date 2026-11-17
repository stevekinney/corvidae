<script lang="ts" module>
  export const title = 'Basic theme switch';
  export const description =
    'Three positions on a sky and night track: Light, System, Dark. Click a position or use the arrow keys, Home and End; the switch reports the selected value.';
</script>

<script lang="ts">
  import { ThemeSwitch, type ThemeSwitchValue } from '@lostgradient/cinder';

  let theme = $state<ThemeSwitchValue>('system');
</script>

<ThemeSwitch bind:value={theme} label="Color theme" />
<p style="margin-top: 0.5rem; color: var(--cinder-text-muted);">Selected: {theme}</p>
