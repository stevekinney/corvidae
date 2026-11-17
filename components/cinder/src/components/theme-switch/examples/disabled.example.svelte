<script lang="ts" module>
  export const title = 'Disabled theme switch';
  export const description =
    'A disabled switch keeps its selection and ignores the pointer and the keyboard.';
</script>

<script lang="ts">
  import { ThemeSwitch } from '@lostgradient/cinder';
</script>

<ThemeSwitch value="dark" label="Color theme" disabled />
