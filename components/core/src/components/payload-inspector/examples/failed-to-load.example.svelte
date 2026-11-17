<script lang="ts" module>
  export const title = 'The payload fails to load';
  export const description =
    'When the payload cannot be loaded the card keeps its header, hides the switch, shows Copy disabled, and the body says so in red with a Try again button.';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';
</script>

<PayloadInspector label="Result" failed onRetry={() => undefined} />
