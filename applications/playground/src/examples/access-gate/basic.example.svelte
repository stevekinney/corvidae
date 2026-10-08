<script lang="ts" module>
  export const title = 'Disabled action';
  export const description =
    'Keeps an unauthorized action visible with an accessible scope reason.';
</script>

<script lang="ts">
  import { AccessGate, Button } from '@lostgradient/cinder';

  const canCancelWorkflow = false;
</script>

<AccessGate granted={canCancelWorkflow} reason="Requires scope: workflows:cancel">
  <Button label="Cancel workflow" variant="danger" />
</AccessGate>
