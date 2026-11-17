<script lang="ts" module>
  export const title = 'Attempts on a list row';
  export const description =
    'One segment per allowed attempt, filled for the attempts made, neutral in every state. It sits beside its count on a row\'s second line; the whole bar is one image named "2 of 5 attempts".';
</script>

<script lang="ts">
  import { AttemptsIndicator } from '@lostgradient/cinder';
</script>

<div
  style="display: grid; gap: 0.5rem; font-size: var(--cinder-text-xs); color: var(--cinder-text-muted);"
>
  <span>Tool runner, <AttemptsIndicator made={2} allowed={5} /> 2 of 5</span>
  <span>Assistant, <AttemptsIndicator made={5} allowed={5} /> 5 of 5</span>
  <span>Assistant, <AttemptsIndicator made={1} allowed={1} /> 1 of 1</span>
</div>
