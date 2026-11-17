<!--
  Root of every fixture a browser-fixture host mounts. It runs the host's `provideContext` while it
  initializes, so whatever context that publishes (the Cinder hosts publish the full-registry code
  highlighter) reaches the fixture, and renders `component` with `componentProps`, adding no element
  of its own.
-->
<script lang="ts">
  import type { Component } from 'svelte';

  type Props = {
    component: Component<any>;
    componentProps: Record<string, any>;
    provideContext?: () => void;
  };

  const props: Props = $props();

  props.provideContext?.();

  const Child = $derived(props.component);
</script>

<Child {...props.componentProps} />
