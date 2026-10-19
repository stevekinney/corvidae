<script lang="ts">
  /**
   * One worker-binding inheritance rule (COR-164), as a static note. The text
   * comes from `worker-inheritance-rules.ts`, where each rule names the Weft
   * source that proves it; a surface renders the rule for its own situation and
   * never words one itself.
   */
  import { Callout } from '@lostgradient/cinder';
  import { Info } from '@lucide/svelte';

  import {
    WORKER_INHERITANCE_RULES,
    type WorkerInheritanceSurface,
  } from './worker-inheritance-rules.ts';

  interface WorkerInheritanceNoteProps {
    readonly surface: WorkerInheritanceSurface;
  }

  let { surface }: WorkerInheritanceNoteProps = $props();

  const rule = $derived(WORKER_INHERITANCE_RULES[surface]);
</script>

<Callout variant="info" semantic="note" title={rule.heading}>
  {#snippet icon()}
    <Info aria-hidden="true" size={17} />
  {/snippet}
  {rule.text}
</Callout>
