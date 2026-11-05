<script lang="ts" module>
  export const title = 'Secret fields masked';
  export const description =
    'Values the caller names as secret paths are masked in both views and in Copy before any layout runs: the Fields view shows bullets and the word "Hidden", and the JSON view shows bullets. Secrets are never revealed here.';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';
  const request = {
    orderId: 4471,
    authorization: 'Bearer abc123',
    apiKey: 'sk_live_9f2',
  };
</script>

<PayloadInspector value={request} label="Input" redact={['authorization', 'apiKey']} />
