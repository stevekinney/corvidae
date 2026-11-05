<script lang="ts" module>
  /** Props of the narrative marker. Not part of the public API. */
  export type RunStepMarkerProps = {
    /** The step's status, which picks the drawing. */
    status: RunStepStatus;
  };
</script>

<script lang="ts">
  import Ban from '@lucide/svelte/icons/ban';
  import Check from '@lucide/svelte/icons/check';
  import X from '@lucide/svelte/icons/x';

  import type { RunStepStatus } from './run-step-timeline.types.ts';

  let { status }: RunStepMarkerProps = $props();
</script>

<!--
  The narrative marker: a green check when it worked, a red cross when it failed, a ban when it was
  canceled, a plain dot for an event with no outcome, a ring for what is under way or waiting, and a
  dashed ring for what has not run. The word for the status is read from the step's label, never
  from this drawing.
-->
<span class="cinder-run-step-marker" data-cinder-status={status} aria-hidden="true">
  {#if status === 'succeeded'}
    <Check class="cinder-run-step-marker__glyph" />
  {:else if status === 'failed' || status === 'timed-out'}
    <X class="cinder-run-step-marker__glyph" />
  {:else if status === 'cancelled'}
    <Ban class="cinder-run-step-marker__glyph" />
  {/if}
</span>
