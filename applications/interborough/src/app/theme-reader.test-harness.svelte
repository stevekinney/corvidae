<script lang="ts">
  /** Test-only child that reads the theme its ancestors provided. Never imported by production code. */
  import { getTheme } from './theme-context.ts';

  const theme = getTheme();
</script>

<output data-testid="theme-mode">{theme === undefined ? 'none' : theme.mode}</output>
