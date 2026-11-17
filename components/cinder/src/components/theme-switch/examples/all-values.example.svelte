<script lang="ts" module>
  export const title = 'All three values';
  export const description =
    'The switch with Light, System and Dark selected in turn: a sky track with a raised thumb on the left, a neutral track in the middle and a night track on the right.';
</script>

<script lang="ts">
  import { ThemeSwitch, type ThemeSwitchValue } from '@lostgradient/cinder';

  let light = $state<ThemeSwitchValue>('light');
  let system = $state<ThemeSwitchValue>('system');
  let dark = $state<ThemeSwitchValue>('dark');
</script>

<div class="example-preview-row">
  <ThemeSwitch bind:value={light} label="Color theme, light" />
  <ThemeSwitch bind:value={system} label="Color theme, system" />
  <ThemeSwitch bind:value={dark} label="Color theme, dark" />
</div>
