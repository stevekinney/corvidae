<script lang="ts" module>
  export const title = 'JSON payload';
  export const description =
    'A highlighted JSON payload draws keys in the accent blue, strings in green and numbers in amber, so a value reads as its own class of token.';
</script>

<script lang="ts">
  import { CodeBlock } from '@lostgradient/cinder';

  const code = `{
  "orderId": "4471",
  "total": 42.0,
  "refunded": false
}`;
</script>

<CodeBlock {code} language="json" copyable />
