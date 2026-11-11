<!--
  The root the design system's bundle mounts: one Cinder component with the given props, and,
  when `fill` is set, a children host as its `children`.
-->
<script lang="ts">
  import type { Component } from 'svelte';

  import BundleChildren from './bundle-children.svelte';
  import type { FillChildren } from './bundle-host.ts';

  let {
    component: Inner,
    props,
    fill,
  }: {
    component: Component<Record<string, unknown>>;
    props: Record<string, unknown>;
    fill?: FillChildren | undefined;
  } = $props();
</script>

{#if fill}
  <Inner {...props}><BundleChildren {fill} /></Inner>
{:else}
  <Inner {...props} />
{/if}
