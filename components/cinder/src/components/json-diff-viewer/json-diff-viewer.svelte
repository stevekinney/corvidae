<script lang="ts" module>
  export type { JsonDiffViewerProps } from './json-diff-viewer.types.ts';
</script>

<script lang="ts">
  import type { JsonDiffViewerProps } from './json-diff-viewer.types.ts';
  import JsonDiffViewerLevel from './_json-diff-viewer-level.svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import { diffJsonValues } from './json-diff-viewer.diff.ts';

  let {
    before,
    after,
    label = 'JSON differences',
    maxDepth = 50,
    class: className,
  }: JsonDiffViewerProps = $props();

  const level = $derived(diffJsonValues(before, after, maxDepth));
</script>

<div class={classNames('cinder-json-diff-viewer', className)} role="group" aria-label={label}>
  {#if level.changes.length === 0}
    <p class="cinder-json-diff-viewer__empty" role="status">No differences</p>
  {:else}
    <JsonDiffViewerLevel {level} />
  {/if}
</div>
