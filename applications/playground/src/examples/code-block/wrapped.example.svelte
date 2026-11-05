<script lang="ts" module>
  export const title = 'Scrolling and wrapping';
  export const description =
    'By default a long line scrolls inside the block with a visible scrollbar. wrap breaks it instead, and a wrapped line keeps one number.';
</script>

<script lang="ts">
  import { CodeBlock } from '@lostgradient/cinder';

  const code = `{
  "description": "Looks up an order, waits for a person to approve, then issues the refund, and tells the customer once it is done.",
  "trigger": { "kind": "signal", "signal": "refund-requested" }
}`;
</script>

<div style="display: grid; gap: 1rem; max-inline-size: 32rem;">
  <CodeBlock {code} lineNumbers />
  <CodeBlock {code} lineNumbers wrap />
</div>
