<script lang="ts" module>
  export const title = 'With remediation, not retryable';
  export const description =
    'A fault that asking again cannot fix: omit onRetry, so the remediation is the only next step and no Try again button is drawn.';
</script>

<script lang="ts">
  import { ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  title="Couldn’t start this run"
  description="The workflow refers to a step that no longer exists. Nothing you did caused it."
  remediation="Open the workflow and remove or replace the missing step, then start the run again."
  detail="E_STEP_MISSING"
/>
