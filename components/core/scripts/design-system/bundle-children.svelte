<!--
  The host the design system's bundle renders a component's `children` into. It records the
  Svelte context it was rendered in, which is the parent component's, so a component mounted into
  the host joins that context.
-->
<script lang="ts">
  import { getAllContexts } from 'svelte';

  import { forgetContexts, rememberContexts, type FillChildren } from './bundle-host.ts';

  let { fill }: { fill: FillChildren } = $props();

  const contexts = getAllContexts();

  function attach(host: HTMLElement): () => void {
    rememberContexts(host, contexts);
    const undo = fill(host);
    return () => {
      undo?.();
      forgetContexts(host);
    };
  }
</script>

<span style="display: contents" data-cinder-children {@attach attach}></span>
