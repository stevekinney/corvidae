<!--
  Root of every component the playground mounts on its own: examples, the
  Playground tab's live preview, and visual fixtures. Each is a separate
  `mount()` root, so it inherits no context from the documentation page around
  it. This publishes the playground's curated code highlighter, then renders
  `component` with `componentProps`, adding no element of its own.
-->
<script lang="ts">
  import { setCodeHighlighterContext } from '@lostgradient/cinder';
  import type { mount } from 'svelte';

  import { curatedCodeHighlighter } from './curated-shiki-adapter.ts';

  type Props = {
    /** Anything Svelte's `mount` accepts, so each call site hands over what it already has. */
    component: Parameters<typeof mount>[0];
    componentProps: Record<string, unknown>;
  };

  let { component: Child, componentProps }: Props = $props();

  setCodeHighlighterContext(curatedCodeHighlighter);
</script>

<Child {...componentProps} />
