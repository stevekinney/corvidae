<script lang="ts" module>
  export const title = 'Secrets masked by key name';
  export const description =
    'With no schema to say which values are secret, a property whose name reads as one (token, key, password, authorization) is masked as a fallback. Pass redact to name the secret paths, or an empty list to hide nothing.';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';
  const request = {
    orderId: 4471,
    authorization: 'Bearer abc123',
    apiKey: 'sk_live_9f2',
  };
</script>

<PayloadInspector value={request} label="Input" />
