<script lang="ts" module>
  export const title = 'Line numbers and notes';
  export const description =
    'Read-only code with line numbers and a note under the line a file problem points at. The numbers and the note are not part of the copied text.';
</script>

<script lang="ts">
  import { CodeBlock } from '@lostgradient/cinder';

  const code = `{
  "name": "order-refund",
  "steps": [
    { "kind": "activity", "handler": "agent",
      "input": { "agent": "tool-runner"
        "message": "Issue the approved refund." } }
  ]
}`;
</script>

<CodeBlock
  {code}
  language="json"
  copyable
  lineNumbers
  annotations={[
    { line: 5, message: 'Missing comma at the end of this line. The parser stopped at line 6.' },
  ]}
/>
