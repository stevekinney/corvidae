<script lang="ts" module>
  export const title = 'A goal with three of five attempts used';
  export const description =
    'On a goal row the bar sits beside its count, "3 of 5", in the same neutral colours in light and dark; running out of attempts never turns it red.';
</script>

<script lang="ts">
  import { AttemptsIndicator } from '@lostgradient/cinder';
</script>

<div
  style="display: grid; gap: 0.5rem; font-size: var(--cinder-text-xs); color: var(--cinder-text-muted);"
>
  <span>Triage the refund queue, <AttemptsIndicator made={3} allowed={5} /> 3 of 5</span>
  <span>Reconcile the ledger, <AttemptsIndicator made={5} allowed={5} /> 5 of 5</span>
</div>
