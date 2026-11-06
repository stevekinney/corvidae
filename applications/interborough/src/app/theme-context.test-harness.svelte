<script lang="ts">
  /**
   * Test-only component that provides a theme the way the shell does, and renders a child that
   * reads it back. Never imported by production code.
   */
  import { untrack } from 'svelte';

  import { provideTheme } from './theme-context.ts';
  import ThemeReader from './theme-reader.test-harness.svelte';
  import type { ThemeStore } from './theme.svelte.ts';

  interface ThemeContextHarnessProps {
    store: ThemeStore;
  }

  let { store }: ThemeContextHarnessProps = $props();

  provideTheme(untrack(() => store));
</script>

<ThemeReader />
