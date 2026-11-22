<script lang="ts" module>
  export const title = 'With remediation and retry';
  export const description =
    'A fault that names its next step and can be retried: the remediation is its own line after the description, and Try again stays the one primary action.';
</script>

<script lang="ts">
  import { ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  title="Couldn’t load runs"
  description="Interborough didn’t answer. Your runs are safe; they’re stored on this machine."
  remediation="Check that Interborough is running, then try again."
  detail="E_UNREACHABLE"
  onRetry={() => {}}
/>
